from __future__ import annotations

import importlib
import os
import sys

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils.text import slugify

from dcim.models import DeviceType, FrontPortTemplate, InterfaceTemplate, Manufacturer, PortTemplateMapping, RearPortTemplate

from netbox_innovace_fibre.models import DeviceTypeSignalMeta, SignalRouting


DEFAULT_FV_ROOT = r"C:\Innovace Tools\Innovace_Fibre_Visualizer(usethis)\Innovace_Fibre_Visualizer"


INTERFACE_TYPE_MAP = {
    'lc': '1000base-x-sfp',
    'fc_apc': '16gfc-sfpp',
    'qsfp28': '100gbase-x-qsfp28',
    'sfp28': '25gbase-x-sfp28',
    'sfp_plus': '10gbase-x-sfpp',
    'rj45': '1000base-t',
    'cfp2': '100gbase-x-cfp2',
}


def _manufacturer_for(type_id: str, name: str, category: str) -> str:
    if category == 'cassette':
        return 'Innovace'
    if type_id in {'edfa', 'voa', 'fibre_line'}:
        return 'Innovace'
    if type_id.startswith('ciena_') or type_id.startswith('m6500_'):
        return 'Ciena'
    if type_id.startswith('infinera_'):
        return 'Infinera'
    if type_id.startswith('polatis_'):
        return 'Polatis'
    if type_id == 'dcs800':
        return 'Stordis'
    if type_id.startswith('aps_'):
        return 'APS Networks'
    if type_id.startswith('dell_'):
        return 'Dell'
    if type_id.startswith('tek_'):
        return 'Tektronix'
    if type_id.startswith('finisar_'):
        return 'Finisar'
    if type_id.startswith('lumacron_'):
        return 'Lumacron'
    if type_id.startswith('kairos_'):
        return 'Kairos'
    if type_id == 'omx3200':
        return 'NetQuest'
    return 'Innovace'


def _port_type_for_template(port_type: str) -> str:
    return {
        'mtp12': 'mpo',
        'lc': 'lc',
        'fc_apc': 'fc-apc',
        'rj45': '8p8c',
        'sfp_plus': 'sfp-plus',
        'sfp28': 'sfp28',
        'qsfp28': 'qsfp28',
        'cfp2': 'cfp2',
        'vga': 'vga',
        'usb': 'usb-a',
        'coax': 'coax',
    }.get(port_type, 'other')


def _interface_type_for_template(port_type: str) -> str:
    return INTERFACE_TYPE_MAP.get(port_type, 'virtual')


def _sanitize_model_name(name: str) -> str:
    # Keep model names ASCII-friendly for NetBox slugs while preserving readability.
    return name.replace('×', 'x')


class Command(BaseCommand):
    help = 'Load Innovace Fibre device types and internal signal routing definitions'

    def add_arguments(self, parser):
        parser.add_argument('--dry-run', action='store_true', default=False)
        parser.add_argument('--force', action='store_true', default=False)
        parser.add_argument('--type', type=str, help='Load only one fibre visualizer type_id')
        parser.add_argument(
            '--fv-root',
            type=str,
            default=DEFAULT_FV_ROOT,
            help='Path to Innovace_Fibre_Visualizer repository root',
        )

    def _load_fv_types(self, fv_root: str):
        if not os.path.isdir(fv_root):
            raise CommandError(f'Fibre Visualizer root not found: {fv_root}')

        if fv_root not in sys.path:
            sys.path.insert(0, fv_root)

        cassette_module = importlib.import_module('app.models.cassette')
        registry = getattr(cassette_module, 'CASSETTE_TYPES', None)
        if not isinstance(registry, dict):
            raise CommandError('Unable to load CASSETTE_TYPES from app.models.cassette')

        return registry

    def handle(self, *args, **options):
        dry_run = options['dry_run']
        force = options['force']
        type_filter = options.get('type')
        fv_root = options['fv_root']

        fv_types = self._load_fv_types(fv_root)
        definitions = list(fv_types.items())
        if type_filter:
            definitions = [d for d in definitions if d[0] == type_filter]

        if not definitions:
            self.stdout.write(self.style.WARNING('No definitions matched the requested filter.'))
            return

        loaded = 0
        with transaction.atomic():
            for type_id, cassette_type in definitions:
                self._load_definition(type_id=type_id, cassette_type=cassette_type, force=force)
                loaded += 1

            if dry_run:
                transaction.set_rollback(True)

        suffix = ' (dry-run)' if dry_run else ''
        self.stdout.write(self.style.SUCCESS(f'Processed {loaded} Innovace device type definitions{suffix}.'))

    def _load_definition(self, type_id, cassette_type, force=False):
        model_name = _sanitize_model_name(cassette_type.name)
        manufacturer_name = _manufacturer_for(type_id, cassette_type.name, cassette_type.category)

        manufacturer, _ = Manufacturer.objects.get_or_create(
            name=manufacturer_name,
            defaults={'slug': slugify(manufacturer_name)[:100]},
        )

        defaults = {
            'slug': slugify(model_name)[:100],
            'u_height': cassette_type.u_height or 1,
            'is_full_depth': False,
        }

        device_type, created = DeviceType.objects.get_or_create(
            manufacturer=manufacturer,
            model=model_name,
            defaults=defaults,
        )

        if created:
            self.stdout.write(f"Created device type: {manufacturer} {device_type.model}")
        elif force:
            for key, value in defaults.items():
                setattr(device_type, key, value)
            device_type.save()
            self.stdout.write(f"Updated device type: {manufacturer} {device_type.model}")

        if force:
            FrontPortTemplate.objects.filter(device_type=device_type).delete()
            RearPortTemplate.objects.filter(device_type=device_type).delete()
            InterfaceTemplate.objects.filter(device_type=device_type).delete()
            SignalRouting.objects.filter(device_type=device_type).delete()

        rear_ports = {}
        front_ports = {}
        interfaces = {}

        use_passive_templates = cassette_type.category == 'cassette'

        for port in cassette_type.ports.values():
            port_type = _port_type_for_template(port.port_type)

            if use_passive_templates:
                if port.direction == 'in':
                    rear_obj, _ = RearPortTemplate.objects.get_or_create(
                        device_type=device_type,
                        name=port.port_id,
                        defaults={
                            'type': port_type,
                            'positions': max(port.num_signals, 1),
                        },
                    )
                    rear_ports[rear_obj.name] = rear_obj
                elif port.direction == 'out':
                    front_obj, _ = FrontPortTemplate.objects.get_or_create(
                        device_type=device_type,
                        name=port.port_id,
                        defaults={
                            'type': port_type,
                            'positions': max(port.num_signals, 1),
                        },
                    )
                    front_ports[front_obj.name] = front_obj
                else:
                    # bidir ports are represented on both faces for pass-through mapping support
                    rear_obj, _ = RearPortTemplate.objects.get_or_create(
                        device_type=device_type,
                        name=f"{port.port_id}_rear",
                        defaults={
                            'type': port_type,
                            'positions': max(port.num_signals, 1),
                        },
                    )
                    front_obj, _ = FrontPortTemplate.objects.get_or_create(
                        device_type=device_type,
                        name=f"{port.port_id}_front",
                        defaults={
                            'type': port_type,
                            'positions': max(port.num_signals, 1),
                        },
                    )
                    rear_ports[rear_obj.name] = rear_obj
                    front_ports[front_obj.name] = front_obj
            else:
                iface_type = _interface_type_for_template(port.port_type)
                iface_obj, _ = InterfaceTemplate.objects.get_or_create(
                    device_type=device_type,
                    name=port.port_id,
                    defaults={
                        'type': iface_type,
                        'mgmt_only': port.port_id in {'mgmt', 'idrac', 'lan', 'net'},
                    },
                )
                interfaces[iface_obj.name] = iface_obj

        if use_passive_templates:
            for (from_port, from_signal), outputs in cassette_type.mapping.items():
                for to_port, to_signal in outputs:
                    front_name = to_port if to_port in front_ports else f"{to_port}_front"
                    rear_name = from_port if from_port in rear_ports else f"{from_port}_rear"

                    front = front_ports.get(front_name)
                    rear = rear_ports.get(rear_name)
                    if front and rear:
                        PortTemplateMapping.objects.get_or_create(
                            front_port=front,
                            rear_port=rear,
                            front_port_position=max(to_signal, 1),
                            rear_port_position=max(from_signal, 1),
                        )

        DeviceTypeSignalMeta.objects.update_or_create(
            device_type=device_type,
            defaults={
                'fibre_viz_type_id': type_id,
                'category': cassette_type.category,
                'mount_type': cassette_type.mount_type,
                'splitter_ratio': '1:2' if type_id in {'1_2_normal', '1_2_special'} else ('1:4' if type_id == '1_4_normal' else ''),
                'is_configurable': bool(cassette_type.configurable),
            },
        )

        reverse_map = {}
        for (from_port, from_signal), outputs in cassette_type.mapping.items():
            for to_port, to_signal in outputs:
                reverse_map.setdefault((to_port, to_signal), set()).add((from_port, from_signal))

        for (from_port, from_signal), outputs in cassette_type.mapping.items():
            for to_port, to_signal in outputs:
                is_bidirectional = (from_port, from_signal) in reverse_map.get((to_port, to_signal), set())
                SignalRouting.objects.get_or_create(
                    device_type=device_type,
                    from_port_name=from_port,
                    from_signal=from_signal,
                    to_port_name=to_port,
                    to_signal=to_signal,
                    defaults={'is_bidirectional': is_bidirectional},
                )
