from django.contrib.contenttypes.models import ContentType
from django.db.models import Q
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework.viewsets import ModelViewSet

from dcim.models import Cable, CableTermination, Device, DeviceRole, FrontPort, RearPort, Site
from netbox_innovace_fibre.models import DeviceTypeSignalMeta, SignalRouting
from netbox_innovace_fibre.tracer import trace_signal_path

from .serializers import DeviceTypeSignalMetaSerializer, SignalRoutingSerializer


class DeviceTypeSignalMetaViewSet(ModelViewSet):
    queryset = DeviceTypeSignalMeta.objects.all()
    serializer_class = DeviceTypeSignalMetaSerializer


class SignalRoutingViewSet(ModelViewSet):
    queryset = SignalRouting.objects.all()
    serializer_class = SignalRoutingSerializer


class SignalTraceAPIView(APIView):
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

    All devices with front/rear ports are returned as nodes, regardless of
    whether they have cables.  Edges are derived from existing cable records.

    Optional query params:
      ?site_id=<id>   — filter to devices in a specific site
      ?role_id=<id>   — filter to devices with a specific role
    """

    def get(self, request):
        site_id = request.GET.get('site_id')
        role_id = request.GET.get('role_id')

        # All devices that have at least one front or rear port
        devices_qs = (
            Device.objects
            .select_related('device_type__manufacturer', 'role', 'site')
            .prefetch_related('frontports', 'rearports')
            .filter(Q(frontports__isnull=False) | Q(rearports__isnull=False))
            .distinct()
        )
        if site_id:
            devices_qs = devices_qs.filter(site_id=site_id)
        if role_id:
            devices_qs = devices_qs.filter(role_id=role_id)

        nodes = {dev.id: _serialise_device(dev) for dev in devices_qs}

        # Build edges from cables between devices in our node set
        fp_ct = ContentType.objects.get_for_model(FrontPort)
        rp_ct = ContentType.objects.get_for_model(RearPort)

        terminations = (
            CableTermination.objects
            .filter(termination_type__in=[fp_ct, rp_ct])
            .select_related('cable')
            .prefetch_related('termination__device')
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


def _serialise_device(dev):
    ports = []
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
