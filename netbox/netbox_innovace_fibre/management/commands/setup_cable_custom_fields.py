from __future__ import annotations

from django.contrib.contenttypes.models import ContentType
from django.core.management.base import BaseCommand

from extras.choices import CustomFieldTypeChoices
from extras.models import CustomField, CustomFieldChoiceSet


class Command(BaseCommand):
    help = 'Create custom fields used by the 3D rack cable renderer (idempotent).'

    def handle(self, *args, **options):
        self._ensure_port_positions()
        self._ensure_cable_exit_side()
        self._ensure_inter_rack_exit_side()
        self._ensure_cable_trunk_group()
        self._ensure_device_barcode()
        self._ensure_cable_barcode_a()
        self._ensure_cable_barcode_b()

    def _ensure_port_positions(self):
        ct = ContentType.objects.get(app_label='dcim', model='devicetype')
        cf, created = CustomField.objects.get_or_create(
            name='port_positions',
            defaults={
                'type': CustomFieldTypeChoices.TYPE_JSON,
                'label': 'Port Positions',
                'description': (
                    'JSON map of port name to normalised {x, y, face} coordinates (0-1). '
                    'Used by the Innovace 3D rack cable renderer.'
                ),
                'required': False,
                'group_name': 'Innovace Cable Viz',
            },
        )
        if created:
            cf.object_types.set([ct])
            self.stdout.write(self.style.SUCCESS('Created custom field: port_positions (DeviceType)'))
        else:
            self.stdout.write('Custom field port_positions already exists — skipped.')

    def _ensure_cable_exit_side(self):
        ct = ContentType.objects.get(app_label='dcim', model='device')
        choice_set, cs_created = CustomFieldChoiceSet.objects.get_or_create(
            name='iff_cable_exit_side',
            defaults={
                'extra_choices': [['left', 'Left'], ['right', 'Right'], ['split', 'Split (50/50)']],
                'description': 'Innovace 3D rack: cable management channel exit side',
            },
        )
        if cs_created:
            self.stdout.write(self.style.SUCCESS('Created choice set: iff_cable_exit_side'))

        cf, created = CustomField.objects.get_or_create(
            name='cable_exit_side',
            defaults={
                'type': CustomFieldTypeChoices.TYPE_SELECT,
                'label': 'Cable Exit Side',
                'choice_set': choice_set,
                'required': False,
                'default': 'left',
                'description': (
                    'Which cable management channel cables from this device exit through. '
                    '"Split" routes left-half ports (x<0.5) left and right-half ports right.'
                ),
                'group_name': 'Innovace Cable Viz',
            },
        )
        if created:
            cf.object_types.set([ct])
            self.stdout.write(self.style.SUCCESS('Created custom field: cable_exit_side (Device)'))
        else:
            self.stdout.write('Custom field cable_exit_side already exists — skipped.')

    def _ensure_inter_rack_exit_side(self):
        ct = ContentType.objects.get(app_label='dcim', model='rack')
        choice_set, cs_created = CustomFieldChoiceSet.objects.get_or_create(
            name='iff_inter_rack_exit_side',
            defaults={
                'extra_choices': [['right', 'Right'], ['left', 'Left']],
                'description': 'Innovace 3D rack: inter-rack trunk cable exit direction at rack top',
            },
        )
        if cs_created:
            self.stdout.write(self.style.SUCCESS('Created choice set: iff_inter_rack_exit_side'))

        cf, created = CustomField.objects.get_or_create(
            name='inter_rack_exit_side',
            defaults={
                'type': CustomFieldTypeChoices.TYPE_SELECT,
                'label': 'Inter-rack Exit Side',
                'choice_set': choice_set,
                'required': False,
                'default': 'right',
                'description': (
                    'Side from which trunk cables exit the top of this rack when connecting to another rack.'
                ),
                'group_name': 'Innovace Cable Viz',
            },
        )
        if created:
            cf.object_types.set([ct])
            self.stdout.write(self.style.SUCCESS('Created custom field: inter_rack_exit_side (Rack)'))
        else:
            self.stdout.write('Custom field inter_rack_exit_side already exists — skipped.')

    def _ensure_device_barcode(self):
        ct = ContentType.objects.get(app_label='dcim', model='device')
        cf, created = CustomField.objects.get_or_create(
            name='iff_barcode',
            defaults={
                'type': CustomFieldTypeChoices.TYPE_TEXT,
                'label': 'Barcode',
                'description': 'Physical barcode label on this device. Assign via Innovace Barcode Manager.',
                'required': False,
                'unique': True,
                'group_name': 'Innovace Barcode',
            },
        )
        if created:
            cf.object_types.set([ct])
            self.stdout.write(self.style.SUCCESS('Created custom field: iff_barcode (Device)'))
        else:
            self.stdout.write('Custom field iff_barcode already exists — skipped.')

    def _ensure_cable_trunk_group(self):
        ct = ContentType.objects.get(app_label='dcim', model='cable')
        cf, created = CustomField.objects.get_or_create(
            name='trunk_group',
            defaults={
                'type': CustomFieldTypeChoices.TYPE_TEXT,
                'label': 'Trunk Group',
                'description': (
                    'Optional visual bundle name for inter-rack cables in the Innovace 3D rack view. '
                    'Cables between the same rack pair with the same group are drawn as one trunk.'
                ),
                'required': False,
                'group_name': 'Innovace Cable Viz',
            },
        )
        if created:
            cf.object_types.set([ct])
            self.stdout.write(self.style.SUCCESS('Created custom field: trunk_group (Cable)'))
        else:
            self.stdout.write('Custom field trunk_group already exists — skipped.')

    def _ensure_cable_barcode_a(self):
        ct = ContentType.objects.get(app_label='dcim', model='cable')
        cf, created = CustomField.objects.get_or_create(
            name='iff_barcode_a',
            defaults={
                'type': CustomFieldTypeChoices.TYPE_TEXT,
                'label': 'Barcode — A End',
                'description': (
                    'Barcode label on the physical A-end connector of this cable. '
                    'The A-end port is shown in the cable detail page under A Terminations.'
                ),
                'required': False,
                'unique': True,
                'group_name': 'Innovace Barcode',
            },
        )
        if created:
            cf.object_types.set([ct])
            self.stdout.write(self.style.SUCCESS('Created custom field: iff_barcode_a (Cable)'))
        else:
            self.stdout.write('Custom field iff_barcode_a already exists — skipped.')

    def _ensure_cable_barcode_b(self):
        ct = ContentType.objects.get(app_label='dcim', model='cable')
        cf, created = CustomField.objects.get_or_create(
            name='iff_barcode_b',
            defaults={
                'type': CustomFieldTypeChoices.TYPE_TEXT,
                'label': 'Barcode — B End',
                'description': (
                    'Barcode label on the physical B-end connector of this cable. '
                    'The B-end port is shown in the cable detail page under B Terminations.'
                ),
                'required': False,
                'unique': True,
                'group_name': 'Innovace Barcode',
            },
        )
        if created:
            cf.object_types.set([ct])
            self.stdout.write(self.style.SUCCESS('Created custom field: iff_barcode_b (Cable)'))
        else:
            self.stdout.write('Custom field iff_barcode_b already exists — skipped.')
