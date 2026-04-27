from rest_framework.response import Response
from rest_framework.viewsets import ModelViewSet
from rest_framework.views import APIView

from dcim.models import DeviceType

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
        device_type = DeviceType.objects.get(pk=pk)
        port = request.GET.get('port')
        signal = int(request.GET.get('signal', '1'))
        paths = trace_signal_path(device_type=device_type, port_name=port, signal=signal)
        return Response(
            {
                'device_type': device_type.pk,
                'port': port,
                'signal': signal,
                'paths': paths,
            }
        )
