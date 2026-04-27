from django.shortcuts import get_object_or_404, render
from django.views import View

from dcim.models import DeviceType

from .models import SignalRouting
from .tracer import trace_signal_path


class TopologyView(View):
    template_name = 'netbox_innovace_fibre/topology.html'

    def get(self, request):
        return render(request, self.template_name)


class DeviceTypeSchematicView(View):
    template_name = 'netbox_innovace_fibre/schematic.html'

    def get(self, request, pk):
        device_type = get_object_or_404(DeviceType, pk=pk)
        routings = SignalRouting.objects.filter(device_type=device_type)
        return render(
            request,
            self.template_name,
            {
                'device_type': device_type,
                'routings': routings,
            },
        )


class SignalTraceView(View):
    template_name = 'netbox_innovace_fibre/signal_trace.html'

    def get(self, request, pk):
        device_type = get_object_or_404(DeviceType, pk=pk)
        port = request.GET.get('port')
        signal = int(request.GET.get('signal', '1'))
        paths = trace_signal_path(device_type, port_name=port, signal=signal)
        return render(
            request,
            self.template_name,
            {
                'device_type': device_type,
                'paths': paths,
                'port': port,
                'signal': signal,
            },
        )
