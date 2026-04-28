from django.shortcuts import get_object_or_404
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework.viewsets import ModelViewSet

from netbox.api.authentication import IsAuthenticatedOrLoginNotRequired

from dcim.models import Cable, CableTermination, Device, DeviceRole, Rack, Site
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
            .order_by('position')
        )

        device_list = []
        for dev in devices_qs:
            dt = dev.device_type
            front_image = dt.front_image.url if dt.front_image else None
            rear_image  = dt.rear_image.url  if dt.rear_image  else None
            device_list.append({
                'id':            dev.pk,
                'name':          dev.name or f'Device {dev.pk}',
                'position':      float(dev.position),
                'face':          dev.face or 'front',
                'u_height':      float(dt.u_height),
                'is_full_depth': dt.is_full_depth,
                'device_type':   dt.model,
                'manufacturer':  dt.manufacturer.name if dt.manufacturer_id else '',
                'role':          dev.role.name  if dev.role_id else '',
                'role_color':    dev.role.color if dev.role_id else '',
                'front_image':   front_image,
                'rear_image':    rear_image,
                'url':           f'/dcim/devices/{dev.pk}/',
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
