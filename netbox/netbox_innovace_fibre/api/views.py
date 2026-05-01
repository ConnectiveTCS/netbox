import re

from django.contrib.contenttypes.models import ContentType
from django.db.models import Q
from django.shortcuts import get_object_or_404
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework.viewsets import ModelViewSet

from netbox.api.authentication import IsAuthenticatedOrLoginNotRequired

from dcim.models import (
    Cable, CableTermination, Device, DeviceBay, DeviceRole, DeviceType,
    FrontPort, Interface, ModuleBay, Rack, RearPort, Site,
)
from dcim.utils import update_interface_bridges
from netbox_innovace_fibre.models import (
    DeviceSignalRouting, DeviceTypeSignalMeta, FloorPlanVersion,
    SignalRouting, TopologyLayoutVersion,
)
from netbox_innovace_fibre.tracer import trace_signal_path, trace_signal_path_for_device

from .serializers import DeviceSignalRoutingSerializer, DeviceTypeSignalMetaSerializer, SignalRoutingSerializer


def _safe_file_url(file_field):
    """Return file URL or None when field is empty/broken."""
    if not file_field:
        return None
    try:
        return file_field.url
    except ValueError:
        return None


def _logical_trace_port_name(port_name):
    return re.sub(r'_(front|rear)$', '', port_name or '', flags=re.IGNORECASE)


class DeviceTypeSignalMetaViewSet(ModelViewSet):
    queryset = DeviceTypeSignalMeta.objects.all()
    serializer_class = DeviceTypeSignalMetaSerializer


class SignalRoutingViewSet(ModelViewSet):
    queryset = SignalRouting.objects.all()
    serializer_class = SignalRoutingSerializer


class DeviceSignalRoutingViewSet(ModelViewSet):
    queryset = DeviceSignalRouting.objects.all()
    serializer_class = DeviceSignalRoutingSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        device_id = self.request.query_params.get('device_id')
        if device_id:
            qs = qs.filter(device_id=device_id)
        return qs


class DeviceSignalTraceAPIView(APIView):
    permission_classes = [IsAuthenticatedOrLoginNotRequired]

    def get(self, request, pk):
        from dcim.models import Device
        device = Device.objects.get(pk=pk)
        port = _logical_trace_port_name(request.GET.get('port'))
        signal = int(request.GET.get('signal', '1'))
        paths = trace_signal_path_for_device(device=device, port_name=port, signal=signal)
        has_overrides = DeviceSignalRouting.objects.filter(device=device).exists()
        return Response({
            'device': device.pk,
            'port': port,
            'signal': signal,
            'using_overrides': has_overrides,
            'paths': paths,
        })


class SignalTraceAPIView(APIView):
    permission_classes = [IsAuthenticatedOrLoginNotRequired]

    def get(self, request, pk):
        from dcim.models import DeviceType
        device_type = DeviceType.objects.get(pk=pk)
        port = _logical_trace_port_name(request.GET.get('port'))
        signal = int(request.GET.get('signal', '1'))
        paths = trace_signal_path(device_type=device_type, port_name=port, signal=signal)
        return Response({
            'device_type': device_type.pk,
            'port': port,
            'signal': signal,
            'paths': paths,
        })


class TopologyDataAPIView(APIView):
    """
    Returns graph data (nodes + edges) for the topology canvas.

    All devices are returned as nodes (filtered by site/role if requested).
    Edges are derived from all cable records regardless of termination type
    (Interface, FrontPort, RearPort, etc.).

    Optional query params:
      ?site_id=<id>   — filter to devices in a specific site
      ?role_id=<id>   — filter to devices with a specific role
    """
    permission_classes = [IsAuthenticatedOrLoginNotRequired]

    def get(self, request):
        site_id = request.GET.get('site_id')
        role_id = request.GET.get('role_id')

        # All devices, regardless of port type
        devices_qs = (
            Device.objects
            .select_related('device_type__manufacturer', 'role', 'site', 'rack', 'parent_bay__device')
            .prefetch_related(
                'interfaces',
                'frontports',
                'rearports',
                'devicebays__installed_device',
                'modulebays__installed_module__module_type',
                'device_type__interfacetemplates',
                'device_type__frontporttemplates',
                'device_type__rearporttemplates',
                'modules__module_type__interfacetemplates',
                'modules__module_type__frontporttemplates',
                'modules__module_type__rearporttemplates',
            )
        )
        if site_id:
            devices_qs = devices_qs.filter(site_id=site_id)
        if role_id:
            devices_qs = devices_qs.filter(role_id=role_id)

        devices = list(devices_qs)
        if request.user.is_authenticated:
            for dev in devices:
                _ensure_topology_ports(dev)

        nodes = {dev.id: _serialise_device(dev) for dev in devices}

        # All cable terminations regardless of port type (Interface, FrontPort, RearPort, …)
        terminations = (
            CableTermination.objects
            .select_related('cable')
            .prefetch_related('termination')
        )

        cable_sides = {}
        for ct in terminations:
            cid = ct.cable_id
            if cid not in cable_sides:
                cable_sides[cid] = {'cable': ct.cable, 'A': [], 'B': []}
            cable_sides[cid][ct.cable_end].append(ct)

        edges = []
        for cid, sides in cable_sides.items():
            cable = sides['cable']
            for a_ct in sides.get('A', []):
                for b_ct in sides.get('B', []):
                    a_port = a_ct.termination
                    b_port = b_ct.termination
                    a_dev = getattr(a_port, 'device', None)
                    b_dev = getattr(b_port, 'device', None)
                    if not a_dev or not b_dev:
                        continue
                    if a_dev.id not in nodes or b_dev.id not in nodes:
                        continue
                    edges.append({
                        'id': cid,
                        'label': cable.label or '',
                        'color': cable.color or '',
                        'source': a_dev.id,
                        'target': b_dev.id,
                        'source_port': a_port.name,
                        'target_port': b_port.name,
                        'source_signal_channel': _positive_int_or_one(
                            cable.custom_field_data.get('source_signal_channel')
                        ),
                        'target_signal_channel': _positive_int_or_one(
                            cable.custom_field_data.get('target_signal_channel')
                        ),
                    })

        all_sites = list(Site.objects.values('id', 'name').order_by('name'))
        all_roles = list(DeviceRole.objects.values('id', 'name').order_by('name'))

        return Response({
            'nodes': list(nodes.values()),
            'edges': edges,
            'filters': {'sites': all_sites, 'roles': all_roles},
        })


class TopologyLayoutAPIView(APIView):
    """
    GET  ?site_id=<id>  — return latest shared topology layout for that site.
    POST {site_id, config} — create a new shared topology layout version.
    """
    permission_classes = [IsAuthenticatedOrLoginNotRequired]

    def get(self, request):
        site_id = request.GET.get('site_id')
        if not site_id:
            return Response({'config': {}, 'version_id': None})
        version = TopologyLayoutVersion.objects.filter(site_id=site_id).first()
        return Response({
            'config': version.config if version else {},
            'version_id': version.pk if version else None,
            'created_at': version.created_at if version else None,
        })

    def post(self, request):
        if not request.user.is_authenticated:
            return Response({'error': 'Authentication required'}, status=403)
        if not (
            request.user.has_perm('netbox_innovace_fibre.add_topologylayoutversion')
            or request.user.has_perm('netbox_innovace_fibre.change_topologylayoutversion')
        ):
            return Response({'error': 'Permission denied'}, status=403)

        site_id = request.data.get('site_id')
        config = request.data.get('config', {})
        if not site_id:
            return Response({'error': 'site_id required'}, status=400)
        if not isinstance(config, dict):
            return Response({'error': 'config must be an object'}, status=400)

        site = get_object_or_404(Site, pk=site_id)
        version = TopologyLayoutVersion.objects.create(
            site=site,
            created_by=request.user,
            config=config,
        )
        return Response({'version_id': version.pk, 'created_at': version.created_at}, status=201)


class RackListAPIView(APIView):
    """
    Lightweight rack list for the 3D Rack View toolbar dropdown.
    Returns all racks (optionally filtered by ?site_id=) plus all sites.
    """
    permission_classes = [IsAuthenticatedOrLoginNotRequired]

    def get(self, request):
        site_id = request.GET.get('site_id')
        qs = Rack.objects.select_related('site').order_by('site__name', 'name')
        if site_id:
            qs = qs.filter(site_id=site_id)
        racks = [
            {'id': r.pk, 'name': r.name, 'site_id': r.site_id, 'site': r.site.name if r.site_id else ''}
            for r in qs
        ]
        all_sites = list(Site.objects.values('id', 'name').order_by('name'))
        return Response({'racks': racks, 'sites': all_sites})


class Rack3DDataAPIView(APIView):
    """
    Full device geometry payload for the 3D rack renderer.
    Returns rack metadata and all racked devices with position, U-height, and image URLs.
    """
    permission_classes = [IsAuthenticatedOrLoginNotRequired]

    def get(self, request, pk):
        rack = get_object_or_404(Rack.objects.select_related('site', 'rack_type'), pk=pk)

        effective_u_height   = rack.rack_type.u_height      if rack.rack_type_id else rack.u_height
        effective_starting   = rack.rack_type.starting_unit if rack.rack_type_id else rack.starting_unit
        effective_desc_units = rack.rack_type.desc_units    if rack.rack_type_id else rack.desc_units

        devices_qs = (
            Device.objects
            .filter(rack=rack, position__isnull=False)
            .select_related('device_type__manufacturer', 'role')
            .prefetch_related(
                'modulebays__installed_module__module_type__images',
                'devicebays__installed_device__device_type__manufacturer',
                'devicebays__installed_device__role',
                'frontports',
                'rearports',
                'interfaces',
            )
            .order_by('position')
        )

        devices = list(devices_qs)
        child_devices = []
        physical_rack_by_device_id = {dev.pk: dev.rack_id for dev in devices}

        device_list = []
        for dev in devices:
            dt = dev.device_type
            front_image = _safe_file_url(dt.front_image)
            rear_image  = _safe_file_url(dt.rear_image)
            role_name = dev.role.name if dev.role_id else ''
            role_slug = dev.role.slug if dev.role_id else ''
            is_patch_enclosure = _is_patch_enclosure_role(role_name, role_slug)
            module_bays = []
            device_bays = []

            if is_patch_enclosure:
                bays = sorted(dev.modulebays.all(), key=_module_bay_sort_key)
                for idx, bay in enumerate(bays, start=1):
                    module = getattr(bay, 'installed_module', None)
                    if not module:
                        continue

                    module_type = module.module_type
                    module_image = None
                    images = list(module_type.images.all()) if module_type else []
                    if images:
                        module_image = _safe_file_url(images[0].image)

                    module_bays.append({
                        'id': bay.pk,
                        'name': bay.name,
                        'position': bay.position or '',
                        'face_slot': _module_bay_face_slot(bay, idx),
                        'layout': _module_bay_layout(bay.position),
                        'module_id': module.pk,
                        'module_name': str(module),
                        'module_type': module_type.model if module_type else '',
                        'module_image': module_image,
                    })

            for idx, bay in enumerate(dev.devicebays.order_by('name'), start=1):
                installed = bay.installed_device if bay.installed_device_id else None
                installed_dt = installed.device_type if installed else None
                if installed:
                    child_devices.append(installed)
                    physical_rack_by_device_id[installed.pk] = rack.pk
                device_image = None
                if installed_dt:
                    device_image = _safe_file_url(installed_dt.front_image) or _safe_file_url(installed_dt.rear_image)

                device_bays.append({
                    'id': bay.pk,
                    'name': bay.name,
                    'face_slot': idx,
                    'layout': _device_bay_layout(bay.description),
                    'occupied': bool(installed),
                    'installed_device_id': installed.pk if installed else None,
                    'installed_device_name': installed.name if installed else '',
                    'installed_device_type': installed_dt.model if installed_dt else '',
                    'installed_device_manufacturer': installed_dt.manufacturer.name if installed_dt and installed_dt.manufacturer_id else '',
                    'installed_device_role': installed.role.name if installed and installed.role_id else '',
                    'installed_device_status': str(installed.status) if installed else '',
                    'installed_device_face': installed.face if installed else '',
                    'installed_device_u_height': float(installed_dt.u_height) if installed_dt else None,
                    'installed_device_is_full_depth': installed_dt.is_full_depth if installed_dt else False,
                    'installed_device_asset_tag': installed.asset_tag if installed else '',
                    'installed_device_serial': installed.serial if installed else '',
                    'installed_device_url': f'/dcim/devices/{installed.pk}/' if installed else '',
                    'installed_device_cable_exit_side': installed.custom_field_data.get('cable_exit_side') if installed else '',
                    'installed_device_port_positions': installed_dt.custom_field_data.get('port_positions') if installed_dt else {},
                    'device_image': device_image,
                })

            device_list.append({
                'id':             dev.pk,
                'name':           dev.name or f'Device {dev.pk}',
                'position':       float(dev.position),
                'face':           dev.face or 'front',
                'u_height':       float(dt.u_height),
                'is_full_depth':  dt.is_full_depth,
                'device_type':    dt.model,
                'device_type_id': dt.pk,
                'manufacturer':   dt.manufacturer.name if dt.manufacturer_id else '',
                'role':           role_name,
                'role_slug':      role_slug,
                'role_color':     dev.role.color if dev.role_id else '',
                'asset_tag':      dev.asset_tag or '',
                'serial':         dev.serial or '',
                'status':         dev.status,
                'front_image':    front_image,
                'rear_image':     rear_image,
                'patch_enclosure': is_patch_enclosure,
                'module_bays':    module_bays,
                'device_bays':    device_bays,
                'url':            f'/dcim/devices/{dev.pk}/',
                'cable_exit_side': dev.custom_field_data.get('cable_exit_side') or 'left',
                'port_positions':  dt.custom_field_data.get('port_positions') or {},
            })

        cables = _build_rack_cables(devices + child_devices, physical_rack_by_device_id)

        return Response({
            'rack': {
                'id':                   rack.pk,
                'name':                 rack.name,
                'u_height':             effective_u_height,
                'starting_unit':        effective_starting,
                'desc_units':           effective_desc_units,
                'site':                 rack.site.name if rack.site_id else '',
                'inter_rack_exit_side': rack.custom_field_data.get('inter_rack_exit_side') or 'right',
            },
            'devices': device_list,
            'cables':  cables,
        })


class BayLayoutAPIView(APIView):
    """
    Load/save per-device bay layouts for the patch enclosure canvas editor.

    ModuleBay layout is stored in ModuleBay.position.
    DeviceBay layout is stored in DeviceBay.description using a plugin marker.
    """
    permission_classes = [IsAuthenticatedOrLoginNotRequired]

    def get(self, request, pk):
        device = get_object_or_404(Device.objects.select_related('role', 'device_type__manufacturer'), pk=pk)

        module_bays = []
        for idx, bay in enumerate(sorted(device.modulebays.all(), key=_module_bay_sort_key), start=1):
            module = getattr(bay, 'installed_module', None)
            module_bays.append({
                'id': bay.pk,
                'name': bay.name,
                'position': bay.position or '',
                'face_slot': _module_bay_face_slot(bay, idx),
                'layout': _module_bay_layout(bay.position),
                'occupied': bool(module),
                'module_name': str(module) if module else '',
            })

        device_bays = []
        for idx, bay in enumerate(device.devicebays.order_by('name'), start=1):
            layout = _device_bay_layout(bay.description)
            device_bays.append({
                'id': bay.pk,
                'name': bay.name,
                'face_slot': idx,
                'layout': layout,
                'occupied': bool(bay.installed_device_id),
                'installed_device': bay.installed_device.name if bay.installed_device_id else '',
            })

        role_name = device.role.name if device.role_id else ''
        role_slug = device.role.slug if device.role_id else ''
        return Response({
            'device': {
                'id': device.pk,
                'name': device.name or f'Device {device.pk}',
                'url': f'/dcim/devices/{device.pk}/',
                'role': role_name,
                'role_slug': role_slug,
                'device_type': device.device_type.model,
                'manufacturer': device.device_type.manufacturer.name if device.device_type.manufacturer_id else '',
                'is_patch_enclosure': _is_patch_enclosure_role(role_name, role_slug),
            },
            'module_bays': module_bays,
            'device_bays': device_bays,
        })

    def post(self, request, pk):
        if not request.user.is_authenticated:
            return Response({'error': 'Authentication required'}, status=403)

        device = get_object_or_404(Device, pk=pk)
        module_updates = request.data.get('module_bays') or []
        device_updates = request.data.get('device_bays') or []

        module_updates_by_id = {int(item['id']): item.get('layout') for item in module_updates if 'id' in item}
        device_updates_by_id = {int(item['id']): item.get('layout') for item in device_updates if 'id' in item}

        try:
            _validate_layout_set(module_updates_by_id)
            _validate_layout_set(device_updates_by_id)
        except ValueError as exc:
            return Response({'error': str(exc)}, status=400)

        updated_module = 0
        for bay in ModuleBay.objects.filter(device=device, pk__in=module_updates_by_id.keys()):
            layout = _normalize_layout(module_updates_by_id.get(bay.pk))
            bay.position = _layout_to_text(layout) if layout else ''
            bay.save(update_fields=['position'])
            updated_module += 1

        updated_device = 0
        for bay in DeviceBay.objects.filter(device=device, pk__in=device_updates_by_id.keys()).select_related('installed_device'):
            layout = _normalize_layout(device_updates_by_id.get(bay.pk))
            bay.description = _set_device_bay_layout_marker(bay.description, layout)
            bay.save(update_fields=['description'])
            updated_device += 1

        return Response({
            'updated_module_bays': updated_module,
            'updated_device_bays': updated_device,
        })


class FloorPlanAPIView(APIView):
    """
    GET  ?site_id=<id>  — return latest saved config for that site (or {} if none)
    POST {site_id, config} — create a new FloorPlanVersion row (versioned history)
    """
    permission_classes = [IsAuthenticatedOrLoginNotRequired]

    def get(self, request):
        site_id = request.GET.get('site_id')
        if not site_id:
            return Response({'config': {}})
        version = FloorPlanVersion.objects.filter(site_id=site_id).first()
        return Response({'config': version.config if version else {}, 'version_id': version.pk if version else None})

    def post(self, request):
        site_id = request.data.get('site_id')
        config  = request.data.get('config', {})
        if not site_id:
            return Response({'error': 'site_id required'}, status=400)
        site = get_object_or_404(Site, pk=site_id)
        user = request.user if request.user.is_authenticated else None
        version = FloorPlanVersion.objects.create(site=site, created_by=user, config=config)
        return Response({'version_id': version.pk, 'created_at': version.created_at}, status=201)


def _ensure_topology_ports(dev):
    """
    Ensure existing devices expose cable endpoints defined by their type/templates.

    NetBox instantiates component templates when a Device or Module is first
    created. If templates are added later, older chassis/devices can appear in
    topology with no connectable ports. This creates only missing topology
    endpoint types and leaves unrelated components alone.
    """
    changed = False

    if dev.device_type_id:
        changed |= _ensure_template_components(dev, dev.device_type)

    for module in dev.modules.all():
        changed |= _ensure_template_components(dev, module.module_type, module=module)

    if changed and hasattr(dev, '_prefetched_objects_cache'):
        for key in ('interfaces', 'frontports', 'rearports'):
            dev._prefetched_objects_cache.pop(key, None)


def _ensure_template_components(device, template_owner, module=None):
    changed = False

    for templates_attr, components_attr in (
        ('interfacetemplates', 'interfaces'),
        ('frontporttemplates', 'frontports'),
        ('rearporttemplates', 'rearports'),
    ):
        if hasattr(device, '_prefetched_objects_cache'):
            device._prefetched_objects_cache.pop(components_attr, None)
        existing = {
            component.name: component
            for component in getattr(device, components_attr).all()
        }

        for template in getattr(template_owner, templates_attr).all():
            component = template.instantiate(device=device, module=module)
            existing_component = existing.get(component.name)

            if existing_component:
                if module and existing_component.module_id is None:
                    existing_component.module = module
                    existing_component.save(update_fields=['module'])
                    changed = True
                continue

            component.save()
            existing[component.name] = component
            changed = True

        if changed and hasattr(device, '_prefetched_objects_cache'):
            device._prefetched_objects_cache.pop(components_attr, None)

    try:
        update_interface_bridges(device, template_owner.interfacetemplates, module)
    except Interface.DoesNotExist:
        pass

    return changed


def _serialise_device(dev):
    ports = []
    for p in dev.interfaces.all():
        ports.append(_serialise_topology_port(p, 'iface', 'dcim.interface'))
    for p in dev.frontports.all():
        ports.append(_serialise_topology_port(p, 'front', 'dcim.frontport'))
    for p in dev.rearports.all():
        ports.append(_serialise_topology_port(p, 'rear', 'dcim.rearport'))
    ports.sort(key=lambda p: p['name'])
    child_devices = []
    for bay in dev.devicebays.all():
        installed = bay.installed_device if bay.installed_device_id else None
        if not installed:
            continue
        child_devices.append({
            'id': installed.pk,
            'name': installed.name or f'Device {installed.pk}',
            'bay_id': bay.pk,
            'bay_name': bay.name,
            'url': f'/dcim/devices/{installed.pk}/',
            'device_type': installed.device_type.model if installed.device_type_id else '',
        })
    modules = []
    for bay in dev.modulebays.all():
        module = bay.installed_module if bay.installed_module_id else None
        if not module:
            continue
        modules.append({
            'id': module.pk,
            'name': str(module),
            'bay_id': bay.pk,
            'bay_name': bay.name,
            'module_type': module.module_type.model if module.module_type_id else '',
        })
    return {
        'id': dev.id,
        'label': dev.name or f'Device {dev.id}',
        'url': f'/dcim/devices/{dev.id}/',
        'manufacturer': dev.device_type.manufacturer.name if dev.device_type_id else '',
        'device_type': dev.device_type.model if dev.device_type_id else '',
        'site': dev.site.name if dev.site_id else '',
        'site_id': dev.site_id,
        'rack_id': dev.rack_id,
        'rack': dev.rack.name if dev.rack_id else '',
        'role': dev.role.name if dev.role_id else '',
        'parent_id': dev.parent_bay.device_id if getattr(dev, 'parent_bay_id', None) else None,
        'parent_bay': dev.parent_bay.name if getattr(dev, 'parent_bay_id', None) else '',
        'children': sorted(child_devices, key=lambda item: item['name']),
        'modules': sorted(modules, key=lambda item: item['name']),
        'ports': ports,
    }


def _serialise_topology_port(port, port_type, object_type):
    module = getattr(port, 'module', None)
    return {
        'id': port.id,
        'name': port.name,
        'type': port_type,
        'object_type': object_type,
        'owner_kind': 'module' if module else 'device',
        'owner_id': module.pk if module else None,
        'owner_name': str(module) if module else '',
        'channel_count': _port_channel_count(port),
    }


def _port_channel_count(port):
    count = getattr(port, 'positions', None) or getattr(port, 'rear_port_position_count', None) or 1
    try:
        return max(1, int(count))
    except (TypeError, ValueError):
        return 1


def _positive_int_or_one(value):
    try:
        return max(1, int(value))
    except (TypeError, ValueError):
        return 1


def _is_patch_enclosure_role(role_name, role_slug):
    role_name = (role_name or '').strip().lower()
    role_slug = (role_slug or '').strip().lower()
    return role_name == 'patch enclosure' or role_slug == 'patch-enclosure'


def _module_bay_sort_key(module_bay):
    # Prefer numeric sorting when positions contain a number, then fall back to name.
    token = module_bay.position or module_bay.name or ''
    match = re.search(r'\d+', token)
    if match:
        return (0, int(match.group(0)), token.lower())
    return (1, 0, token.lower())


def _module_bay_face_slot(module_bay, default_slot):
    token = module_bay.position or ''
    match = re.search(r'\d+', token)
    if match:
        return max(int(match.group(0)), 1)
    return default_slot


def _module_bay_layout(position_text):
    """
    Parse optional proportional bay placement from ModuleBay.position.

    Supported formats:
      - "x=5,y=10,w=20,h=15"
      - "5,10,20,15"

    Values are percentages in the range [0, 100], where:
      - x/y are top-left offsets from the face origin
      - w/h are width/height percentages
    """
    if not position_text:
        return None

    text = position_text.strip()
    if not text:
        return None

    def _norm(v):
        try:
            n = float(str(v).replace('%', '').strip())
        except (TypeError, ValueError):
            return None
        return max(0.0, min(100.0, n))

    kv = re.findall(r'([xywh])\s*=\s*([0-9]+(?:\.[0-9]+)?%?)', text, flags=re.IGNORECASE)
    if kv:
        data = {k.lower(): _norm(v) for k, v in kv}
        x = data.get('x')
        y = data.get('y')
        w = data.get('w')
        h = data.get('h')
        if None not in (x, y, w, h) and w > 0 and h > 0:
            return {'x': x, 'y': y, 'w': w, 'h': h}

    nums = re.findall(r'([0-9]+(?:\.[0-9]+)?%?)', text)
    if len(nums) >= 4:
        x, y, w, h = (_norm(nums[i]) for i in range(4))
        if None not in (x, y, w, h) and w > 0 and h > 0:
            return {'x': x, 'y': y, 'w': w, 'h': h}

    return None


def _normalize_layout(layout):
    if not isinstance(layout, dict):
        return None
    try:
        x = max(0.0, min(100.0, float(layout.get('x'))))
        y = max(0.0, min(100.0, float(layout.get('y'))))
        w = max(0.1, min(100.0, float(layout.get('w'))))
        h = max(0.1, min(100.0, float(layout.get('h'))))
    except (TypeError, ValueError):
        return None
    return {'x': x, 'y': y, 'w': w, 'h': h}


def _layout_to_text(layout):
    if not layout:
        return ''
    # Keep this compact for ModuleBay.position (varchar(30)).
    return f"{layout['x']:.2f},{layout['y']:.2f},{layout['w']:.2f},{layout['h']:.2f}"


def _overlaps(a, b):
    ax1, ay1 = a['x'], a['y']
    ax2, ay2 = a['x'] + a['w'], a['y'] + a['h']
    bx1, by1 = b['x'], b['y']
    bx2, by2 = b['x'] + b['w'], b['y'] + b['h']
    return not (ax2 <= bx1 or bx2 <= ax1 or ay2 <= by1 or by2 <= ay1)


def _validate_layout_set(layouts_by_id):
    parsed = []
    for bay_id, layout in layouts_by_id.items():
        norm = _normalize_layout(layout)
        if not norm:
            continue
        if norm['x'] + norm['w'] > 100.0 or norm['y'] + norm['h'] > 100.0:
            raise ValueError(f'Layout for bay {bay_id} exceeds face bounds')
        parsed.append((bay_id, norm))

    for i in range(len(parsed)):
        for j in range(i + 1, len(parsed)):
            a_id, a_layout = parsed[i]
            b_id, b_layout = parsed[j]
            if _overlaps(a_layout, b_layout):
                raise ValueError(f'Layouts overlap for bays {a_id} and {b_id}')


def _device_bay_layout(description):
    if not description:
        return None
    match = re.search(r'__iff_layout__=([^\s;]+)', description)
    if not match:
        return None
    return _module_bay_layout(match.group(1))


def _set_device_bay_layout_marker(description, layout):
    base = re.sub(r'\s*__iff_layout__=[^\s;]+', '', description or '').strip()
    if not layout:
        return base
    marker = f"__iff_layout__={_layout_to_text(layout)}"
    return f'{base} {marker}'.strip()


def _build_rack_cables(devices_qs, physical_rack_by_device_id=None):
    """
    Build a cable list for all cables that have at least one termination on a device
    in this rack (already fetched with frontports/rearports/interfaces prefetched).

    Returns a list of dicts with the shape:
      {id, label, color, type, a_terminations: [...], b_terminations: [...]}
    where each termination is {port_name, port_type, device_id, rack_id}.
    """
    # Build a port lookup from the prefetched port data so we can resolve
    # terminations without extra queries for in-rack ports.
    fp_ct_id = ContentType.objects.get_for_model(FrontPort).pk
    rp_ct_id = ContentType.objects.get_for_model(RearPort).pk
    if_ct_id = ContentType.objects.get_for_model(Interface).pk

    port_lookup = {}  # (ct_id, port_id) → (port_type_label, port_name, device_id, rack_id)
    cable_id_set = set()
    physical_rack_by_device_id = physical_rack_by_device_id or {}

    for dev in devices_qs:
        rack_id = physical_rack_by_device_id.get(dev.pk, dev.rack_id)
        for port in dev.frontports.all():
            port_lookup[(fp_ct_id, port.pk)] = ('frontport', port.name, dev.pk, rack_id)
            if port.cable_id:
                cable_id_set.add(port.cable_id)
        for port in dev.rearports.all():
            port_lookup[(rp_ct_id, port.pk)] = ('rearport', port.name, dev.pk, rack_id)
            if port.cable_id:
                cable_id_set.add(port.cable_id)
        for port in dev.interfaces.all():
            port_lookup[(if_ct_id, port.pk)] = ('interface', port.name, dev.pk, rack_id)
            if port.cable_id:
                cable_id_set.add(port.cable_id)

    if not cable_id_set:
        return []

    # Fetch all terminations for those cables in two queries.
    terminations_qs = (
        CableTermination.objects
        .filter(cable_id__in=cable_id_set)
        .select_related('cable', 'termination_type')
    )

    # For terminations not in our rack (inter-rack), we need to resolve
    # device_id / rack_id from the actual port objects.  Collect unknowns first,
    # then fetch by content-type in bulk to avoid per-row queries.
    unknown_by_ct: dict[int, list[int]] = {}
    all_term_rows = list(terminations_qs)
    for ct_row in all_term_rows:
        key = (ct_row.termination_type_id, ct_row.termination_id)
        if key not in port_lookup:
            ct_id = ct_row.termination_type_id
            unknown_by_ct.setdefault(ct_id, []).append(ct_row.termination_id)

    # Resolve unknown ports by content type → model class.
    ct_model_map = {fp_ct_id: FrontPort, rp_ct_id: RearPort, if_ct_id: Interface}
    ct_label_map = {fp_ct_id: 'frontport', rp_ct_id: 'rearport', if_ct_id: 'interface'}
    for ct_id, port_ids in unknown_by_ct.items():
        model_cls = ct_model_map.get(ct_id)
        if not model_cls:
            continue
        label = ct_label_map[ct_id]
        for port in model_cls.objects.filter(pk__in=port_ids).select_related('device'):
            dev = port.device
            port_lookup[(ct_id, port.pk)] = (label, port.name, dev.pk if dev else None, dev.rack_id if dev else None)

    # Group terminations by cable.
    cable_terms: dict[int, dict] = {}
    for ct_row in all_term_rows:
        cid = ct_row.cable_id
        if cid not in cable_terms:
            c = ct_row.cable
            custom_fields = c.custom_field_data or {}
            trunk_group = (
                custom_fields.get('trunk_group')
                or custom_fields.get('bundle_group')
                or custom_fields.get('cable_trunk_group')
                or custom_fields.get('iff_trunk_group')
                or ''
            )
            cable_terms[cid] = {
                'id':    c.pk,
                'label': c.label or '',
                'color': c.color or '',
                'type':  c.type or '',
                'trunk_group': trunk_group,
                'a_terminations': [],
                'b_terminations': [],
            }
        key = (ct_row.termination_type_id, ct_row.termination_id)
        info = port_lookup.get(key)
        if info:
            port_type, port_name, device_id, rack_id = info
        else:
            port_type = ct_row.termination_type.model if ct_row.termination_type_id else 'unknown'
            port_name = f'#{ct_row.termination_id}'
            device_id = None
            rack_id   = None

        entry = {
            'port_name': port_name,
            'port_type': port_type,
            'device_id': device_id,
            'rack_id':   rack_id,
        }
        end_key = 'a_terminations' if ct_row.cable_end == 'A' else 'b_terminations'
        cable_terms[cid][end_key].append(entry)

    return list(cable_terms.values())


def _enumerate_device_type_ports(dt):
    """Return all port template names on a DeviceType as a sorted list."""
    ports = []
    for p in dt.frontporttemplates.all():
        ports.append({'name': p.name, 'type': 'frontport', 'face': 'front'})
    for p in dt.rearporttemplates.all():
        ports.append({'name': p.name, 'type': 'rearport', 'face': 'rear'})
    for p in dt.interfacetemplates.all():
        ports.append({'name': p.name, 'type': 'interface', 'face': 'front'})
    return sorted(ports, key=lambda x: x['name'])


class PortLayoutAPIView(APIView):
    """
    GET  /api/plugins/innovace-fibre/device-types/<pk>/port-layout/
    POST /api/plugins/innovace-fibre/device-types/<pk>/port-layout/

    Reads and writes the port_positions custom field on a DeviceType.
    Only available for device types that have a front or rear image.
    """
    permission_classes = [IsAuthenticatedOrLoginNotRequired]

    def get(self, request, pk):
        dt = get_object_or_404(
            DeviceType.objects
            .select_related('manufacturer')
            .prefetch_related('frontporttemplates', 'rearporttemplates', 'interfacetemplates'),
            pk=pk,
        )
        return Response({
            'device_type_id': dt.pk,
            'model':          dt.model,
            'manufacturer':   dt.manufacturer.name if dt.manufacturer_id else '',
            'u_height':       float(dt.u_height),
            'front_image':    _safe_file_url(dt.front_image),
            'rear_image':     _safe_file_url(dt.rear_image),
            'port_positions': dt.custom_field_data.get('port_positions') or {},
            'ports':          _enumerate_device_type_ports(dt),
            'has_rear_ports': dt.rearporttemplates.exists(),
        })

    def post(self, request, pk):
        if not request.user.is_authenticated:
            return Response({'error': 'Authentication required'}, status=403)
        dt = get_object_or_404(DeviceType, pk=pk)
        positions = request.data.get('port_positions')
        if not isinstance(positions, dict):
            return Response({'error': 'port_positions must be a JSON object'}, status=400)
        dt.custom_field_data['port_positions'] = positions
        dt.save(update_fields=['custom_field_data'])
        return Response({'saved': True, 'port_positions': positions})


class PortLayoutListAPIView(APIView):
    """
    GET /api/plugins/innovace-fibre/device-types/port-layout-list/

    Returns all DeviceTypes that have a front or rear image, with a flag
    indicating whether port_positions have been configured.
    """
    permission_classes = [IsAuthenticatedOrLoginNotRequired]

    def get(self, request):
        qs = (
            DeviceType.objects
            .select_related('manufacturer')
            .filter(Q(front_image__isnull=False) | Q(rear_image__isnull=False))
            .exclude(front_image='', rear_image='')
            .order_by('manufacturer__name', 'model')
        )
        result = []
        for dt in qs:
            front_image = _safe_file_url(dt.front_image)
            rear_image = _safe_file_url(dt.rear_image)
            positions = dt.custom_field_data.get('port_positions') or {}
            result.append({
                'id':               dt.pk,
                'model':            dt.model,
                'manufacturer':     dt.manufacturer.name if dt.manufacturer_id else '',
                'front_image':      front_image,
                'rear_image':       rear_image,
                'port_positions_set': bool(positions),
                'port_count':         len(positions),
            })
        return Response({'device_types': result})


class BarcodeLookupAPIView(APIView):
    """
    GET /api/plugins/innovace-fibre/barcode-lookup/?barcode=XXX

    Searches for a device or cable matching the given barcode string.
    Checks Device.iff_barcode, Cable.iff_barcode_a, and Cable.iff_barcode_b.
    Returns a JSON object describing the matched object, including signal list
    for cables (used to drive the multi-signal trace modal).
    """
    permission_classes = [IsAuthenticatedOrLoginNotRequired]

    def get(self, request):
        barcode = request.query_params.get('barcode', '').strip()
        if not barcode:
            return Response({'error': 'barcode param required'}, status=400)

        device = (
            Device.objects
            .select_related('site', 'rack', 'device_type', 'role', 'parent_bay__device')
            .filter(custom_field_data__iff_barcode=barcode)
            .first()
        )
        if device:
            return Response(_serialise_barcode_device(device))

        cable = (
            Cable.objects
            .prefetch_related('terminations__termination')
            .filter(custom_field_data__iff_barcode_a=barcode)
            .first()
        )
        matched_end = 'a'
        if not cable:
            cable = (
                Cable.objects
                .prefetch_related('terminations__termination')
                .filter(custom_field_data__iff_barcode_b=barcode)
                .first()
            )
            matched_end = 'b'

        if cable:
            return Response(_serialise_barcode_cable(cable, matched_end))

        return Response(
            {'error': f'No device or cable found for barcode “{barcode}”'},
            status=404,
        )


class BarcodeBulkAssignAPIView(APIView):
    """
    POST /api/plugins/innovace-fibre/barcode-bulk-assign/

    Accepts a JSON array of assignment objects:
      For devices:  {"object_type": "device", "id": 42, "barcode": "BC-001"}
      For cables:   {"object_type": "cable",  "id": 55, "barcode_a": "X", "barcode_b": "Y"}

    Validates uniqueness per row and saves custom_field_data.
    Returns {"saved": N, "errors": [{"index": i, "error": "..."}]}.
    """
    permission_classes = [IsAuthenticatedOrLoginNotRequired]

    def post(self, request):
        if not request.user.is_authenticated:
            return Response({'error': 'Authentication required'}, status=403)

        items = request.data
        if not isinstance(items, list):
            return Response({'error': 'Expected a JSON array'}, status=400)

        saved = 0
        errors = []

        for i, item in enumerate(items):
            obj_type = item.get('object_type', '')
            obj_id = item.get('id')
            try:
                if obj_type == 'device':
                    device = Device.objects.get(pk=obj_id)
                    barcode = (item.get('barcode') or '').strip()
                    if barcode:
                        existing = Device.objects.filter(
                            custom_field_data__iff_barcode=barcode
                        ).exclude(pk=obj_id).first()
                        if existing:
                            errors.append({'index': i, 'error': f'Barcode already assigned to {existing.name}'})
                            continue
                    device.custom_field_data['iff_barcode'] = barcode or None
                    device.save(update_fields=['custom_field_data'])
                    saved += 1

                elif obj_type == 'cable':
                    cable = Cable.objects.get(pk=obj_id)
                    barcode_a = (item.get('barcode_a') or '').strip() or None
                    barcode_b = (item.get('barcode_b') or '').strip() or None
                    for field, value in [('iff_barcode_a', barcode_a), ('iff_barcode_b', barcode_b)]:
                        if value:
                            existing = Cable.objects.filter(
                                **{f'custom_field_data__{field}': value}
                            ).exclude(pk=obj_id).first()
                            if existing:
                                errors.append({'index': i, 'error': f'{field} already assigned to cable {existing.pk}'})
                                value = None
                    cable.custom_field_data['iff_barcode_a'] = barcode_a
                    cable.custom_field_data['iff_barcode_b'] = barcode_b
                    cable.save(update_fields=['custom_field_data'])
                    saved += 1

                else:
                    errors.append({'index': i, 'error': f'Unknown object_type: {obj_type!r}'})

            except (Device.DoesNotExist, Cable.DoesNotExist):
                errors.append({'index': i, 'error': f'{obj_type} id={obj_id} not found'})
            except Exception as exc:
                errors.append({'index': i, 'error': str(exc)})

        return Response({'saved': saved, 'errors': errors})


def _serialise_barcode_device(device):
    parent_bay = getattr(device, 'parent_bay', None)
    parent_info = None
    if parent_bay:
        parent_dev = parent_bay.device
        parent_info = {
            'id': parent_dev.pk,
            'name': parent_dev.name or f'Device {parent_dev.pk}',
            'bay': parent_bay.name,
            'url': f'/dcim/devices/{parent_dev.pk}/',
        }
    return {
        'type': 'device',
        'id': device.pk,
        'name': device.name or f'Device {device.pk}',
        'url': f'/dcim/devices/{device.pk}/',
        'site': {'id': device.site_id, 'name': device.site.name} if device.site_id else None,
        'rack': {'id': device.rack_id, 'name': device.rack.name} if device.rack_id else None,
        'rack_unit': float(device.position) if device.position else None,
        'role': device.role.name if device.role_id else '',
        'device_type': device.device_type.model if device.device_type_id else '',
        'parent_device': parent_info,
    }


def _serialise_barcode_cable(cable, matched_end):
    a_terms = []
    b_terms = []
    matched_device = None
    matched_port = None

    for ct in cable.terminations.all():
        port = ct.termination
        if port is None:
            continue
        dev = getattr(port, 'device', None)
        entry = {
            'device_id': dev.pk if dev else None,
            'device_name': dev.name if dev else '',
            'port_name': port.name,
            'object_type': f'dcim.{type(port).__name__.lower()}',
        }
        if ct.cable_end == 'A':
            a_terms.append(entry)
            if matched_end == 'a' and matched_device is None and dev:
                matched_device = dev
                matched_port = port.name
        else:
            b_terms.append(entry)
            if matched_end == 'b' and matched_device is None and dev:
                matched_device = dev
                matched_port = port.name

    signals = _get_port_signals(matched_device, matched_port) if matched_device and matched_port else [1]

    return {
        'type': 'cable',
        'id': cable.pk,
        'label': cable.label or '',
        'matched_end': matched_end,
        'a_terminations': a_terms,
        'b_terminations': b_terms,
        'signals': signals,
    }


def _get_port_signals(device, port_name):
    """Return sorted list of distinct signal numbers for a device port (from overrides or type defaults)."""
    device_signals = list(
        DeviceSignalRouting.objects
        .filter(device=device, from_port_name=port_name)
        .values_list('from_signal', flat=True)
        .distinct()
    )
    if device_signals:
        return sorted(set(device_signals))

    type_signals = list(
        SignalRouting.objects
        .filter(device_type=device.device_type, from_port_name=port_name)
        .values_list('from_signal', flat=True)
        .distinct()
    )
    if type_signals:
        return sorted(set(type_signals))

    return [1]
