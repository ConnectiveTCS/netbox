from django.contrib.contenttypes.models import ContentType
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

    Optional query params:
      ?site_id=<id>   — filter to devices in a specific site
      ?role_id=<id>   — filter to devices with a specific role
    """

    def get(self, request):
        fp_ct = ContentType.objects.get_for_model(FrontPort)
        rp_ct = ContentType.objects.get_for_model(RearPort)

        # All cable terminations on front/rear ports, with device context
        terminations = (
            CableTermination.objects
            .filter(termination_type__in=[fp_ct, rp_ct])
            .select_related(
                'cable',
                'termination_type',
            )
            .prefetch_related('termination__device__device_type__manufacturer',
                              'termination__device__role',
                              'termination__device__site')
        )

        # Group terminations by cable → side
        cable_sides = {}
        for ct in terminations:
            cid = ct.cable_id
            if cid not in cable_sides:
                cable_sides[cid] = {'cable': ct.cable, 'A': [], 'B': []}
            cable_sides[cid][ct.cable_end].append(ct)

        # Site/role filters
        site_id = request.GET.get('site_id')
        role_id = request.GET.get('role_id')

        nodes = {}
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

                    # Apply filters
                    if site_id:
                        if str(a_dev.site_id) != site_id and str(b_dev.site_id) != site_id:
                            continue
                    if role_id:
                        if str(a_dev.role_id) != role_id and str(b_dev.role_id) != role_id:
                            continue

                    for dev in (a_dev, b_dev):
                        if dev.id not in nodes:
                            nodes[dev.id] = _serialise_device(dev)

                    edges.append({
                        'id': cid,
                        'label': cable.label or '',
                        'color': cable.color or '',
                        'source': a_dev.id,
                        'target': b_dev.id,
                        'source_port': a_port.name,
                        'target_port': b_port.name,
                    })

        # Build filter options for the UI
        all_sites = list(Site.objects.values('id', 'name').order_by('name'))
        all_roles = list(DeviceRole.objects.values('id', 'name').order_by('name'))

        return Response({
            'nodes': list(nodes.values()),
            'edges': edges,
            'filters': {
                'sites': all_sites,
                'roles': all_roles,
            },
        })


def _serialise_device(dev):
    return {
        'id': dev.id,
        'label': dev.name or f'Device {dev.id}',
        'url': f'/dcim/devices/{dev.id}/',
        'manufacturer': dev.device_type.manufacturer.name if dev.device_type_id else '',
        'device_type': dev.device_type.model if dev.device_type_id else '',
        'site': dev.site.name if dev.site_id else '',
        'role': dev.role.name if dev.role_id else '',
    }
