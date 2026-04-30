import re

from django.shortcuts import get_object_or_404
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework.viewsets import ModelViewSet

from netbox.api.authentication import IsAuthenticatedOrLoginNotRequired

from dcim.models import Cable, CableTermination, Device, DeviceBay, DeviceRole, ModuleBay, Rack, Site
from netbox_innovace_fibre.models import DeviceSignalRouting, DeviceTypeSignalMeta, FloorPlanVersion, SignalRouting
from netbox_innovace_fibre.tracer import trace_signal_path, trace_signal_path_for_device

from .serializers import DeviceSignalRoutingSerializer, DeviceTypeSignalMetaSerializer, SignalRoutingSerializer


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
        port = request.GET.get('port')
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
        port = request.GET.get('port')
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
            .select_related('device_type__manufacturer', 'role', 'site')
            .prefetch_related('interfaces', 'frontports', 'rearports')
        )
        if site_id:
            devices_qs = devices_qs.filter(site_id=site_id)
        if role_id:
            devices_qs = devices_qs.filter(role_id=role_id)

        nodes = {dev.id: _serialise_device(dev) for dev in devices_qs}

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
                    })

        all_sites = list(Site.objects.values('id', 'name').order_by('name'))
        all_roles = list(DeviceRole.objects.values('id', 'name').order_by('name'))

        return Response({
            'nodes': list(nodes.values()),
            'edges': edges,
            'filters': {'sites': all_sites, 'roles': all_roles},
        })


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
            )
            .order_by('position')
        )

        device_list = []
        for dev in devices_qs:
            dt = dev.device_type
            front_image = dt.front_image.url if dt.front_image else None
            rear_image  = dt.rear_image.url  if dt.rear_image  else None
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
                    if images and images[0].image:
                        module_image = images[0].image.url

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
                    device_image = None
                    if installed_dt:
                        if installed_dt.front_image:
                            device_image = installed_dt.front_image.url
                        elif installed_dt.rear_image:
                            device_image = installed_dt.rear_image.url

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
            })

        return Response({
            'rack': {
                'id':            rack.pk,
                'name':          rack.name,
                'u_height':      effective_u_height,
                'starting_unit': effective_starting,
                'desc_units':    effective_desc_units,
                'site':          rack.site.name if rack.site_id else '',
            },
            'devices': device_list,
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


def _serialise_device(dev):
    ports = []
    for p in dev.interfaces.all():
        ports.append({'id': p.id, 'name': p.name, 'type': 'iface', 'object_type': 'dcim.interface'})
    for p in dev.frontports.all():
        ports.append({'id': p.id, 'name': p.name, 'type': 'front', 'object_type': 'dcim.frontport'})
    for p in dev.rearports.all():
        ports.append({'id': p.id, 'name': p.name, 'type': 'rear', 'object_type': 'dcim.rearport'})
    ports.sort(key=lambda p: p['name'])
    return {
        'id': dev.id,
        'label': dev.name or f'Device {dev.id}',
        'url': f'/dcim/devices/{dev.id}/',
        'manufacturer': dev.device_type.manufacturer.name if dev.device_type_id else '',
        'device_type': dev.device_type.model if dev.device_type_id else '',
        'site': dev.site.name if dev.site_id else '',
        'role': dev.role.name if dev.role_id else '',
        'ports': ports,
    }


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
