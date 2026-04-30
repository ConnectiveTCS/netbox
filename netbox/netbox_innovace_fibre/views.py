from django.db.models import Count
from django.http import HttpResponseRedirect
from django.shortcuts import get_object_or_404, render
from django.urls import reverse
from django.views import View

from dcim.models import Device, DeviceType

from .forms import DeviceSignalRoutingForm
from .models import DeviceSignalRouting, SignalRouting
from .tables import DeviceCustomMappingTable
from .tracer import trace_signal_path, trace_signal_path_for_device


class Rack3DView(View):
    template_name = 'netbox_innovace_fibre/rack_3d.html'

    def get(self, request):
        return render(request, self.template_name)


class PatchEnclosureBayLayoutView(View):
    template_name = 'netbox_innovace_fibre/bay_layout_editor.html'

    def get(self, request, pk):
        device = get_object_or_404(Device.objects.select_related('role', 'device_type__manufacturer'), pk=pk)
        role_name = device.role.name if device.role_id else ''
        role_slug = device.role.slug if device.role_id else ''
        is_patch_enclosure = role_name.lower() == 'patch enclosure' or role_slug.lower() == 'patch-enclosure'
        return render(
            request,
            self.template_name,
            {
                'device': device,
                'is_patch_enclosure': is_patch_enclosure,
            },
        )


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


class CustomMappingListView(View):
    """Lists all devices with their signal routing override counts."""
    template_name = 'netbox_innovace_fibre/custom_mapping_list.html'

    def get(self, request):
        devices = Device.objects.annotate(
            override_count=Count('innovace_signal_routings')
        ).select_related('site', 'rack', 'device_type').order_by('name')
        table = DeviceCustomMappingTable(devices)
        return render(request, self.template_name, {'table': table})


class DeviceSignalRoutingView(View):
    """Lists per-device signal routing overrides and shows device type defaults for reference."""
    template_name = 'netbox_innovace_fibre/device_signal_routing.html'

    def get(self, request, pk):
        device = get_object_or_404(Device, pk=pk)
        overrides = DeviceSignalRouting.objects.filter(device=device)
        type_defaults = SignalRouting.objects.filter(device_type=device.device_type)
        form = DeviceSignalRoutingForm()
        return render(
            request,
            self.template_name,
            {
                'device': device,
                'overrides': overrides,
                'type_defaults': type_defaults,
                'form': form,
            },
        )

    def post(self, request, pk):
        device = get_object_or_404(Device, pk=pk)
        form = DeviceSignalRoutingForm(request.POST)
        if form.is_valid():
            routing = form.save(commit=False)
            routing.device = device
            routing.save()
        return HttpResponseRedirect(
            reverse('plugins:netbox_innovace_fibre:device_signal_routing', kwargs={'pk': pk})
        )


class DeviceSignalRoutingDeleteView(View):
    """Deletes a single DeviceSignalRouting row."""

    def post(self, request, pk, route_pk):
        device = get_object_or_404(Device, pk=pk)
        route = get_object_or_404(DeviceSignalRouting, pk=route_pk, device=device)
        route.delete()
        return HttpResponseRedirect(
            reverse('plugins:netbox_innovace_fibre:device_signal_routing', kwargs={'pk': pk})
        )


class DeviceSignalTraceView(View):
    """Signal path trace for a specific device instance."""
    template_name = 'netbox_innovace_fibre/device_signal_trace.html'

    def get(self, request, pk):
        device = get_object_or_404(Device, pk=pk)
        port = request.GET.get('port') or None
        signal = int(request.GET.get('signal', '1'))

        device_routes = list(DeviceSignalRouting.objects.filter(device=device))
        has_overrides = bool(device_routes)
        if has_overrides:
            available_ports = sorted({r.from_port_name for r in device_routes})
        else:
            available_ports = sorted(set(
                SignalRouting.objects.filter(device_type=device.device_type)
                .values_list('from_port_name', flat=True)
            ))

        paths = trace_signal_path_for_device(device=device, port_name=port, signal=signal)
        return render(
            request,
            self.template_name,
            {
                'device': device,
                'paths': paths,
                'port': port,
                'signal': signal,
                'has_overrides': has_overrides,
                'available_ports': available_ports,
            },
        )
