import csv
import io

from django.contrib.auth.mixins import LoginRequiredMixin
from django.db.models import Count, Q
from django.http import Http404, HttpResponse, HttpResponseRedirect, JsonResponse
from django.shortcuts import get_object_or_404, render
from django.urls import reverse
from django.views import View

from dcim.models import Cable, CableTermination, Device, DeviceType

from .forms import DeviceSignalRoutingForm
from .models import DeviceSignalRouting, SignalRouting
from .tables import DeviceCustomMappingTable
from .tracer import trace_signal_path, trace_signal_path_for_device


def _safe_image_url(image_field):
    """Return a file URL for an ImageField/FileField, or None if unavailable."""
    if not image_field:
        return None
    try:
        return image_field.url
    except ValueError:
        return None


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


class PortLayoutListView(View):
    template_name = 'netbox_innovace_fibre/port_layout_list.html'

    def get(self, request):
        device_types = (
            DeviceType.objects
            .exclude(Q(front_image='') & Q(rear_image=''))
            .select_related('manufacturer')
            .order_by('manufacturer__name', 'model')
        )
        return render(request, self.template_name, {'device_types': device_types})


class PortLayoutEditorView(View):
    template_name = 'netbox_innovace_fibre/port_layout_editor.html'

    def get(self, request, pk):
        device_type = get_object_or_404(
            DeviceType.objects.select_related('manufacturer'), pk=pk,
        )
        front_image_url = _safe_image_url(device_type.front_image)
        rear_image_url = _safe_image_url(device_type.rear_image)
        if not front_image_url and not rear_image_url:
            raise Http404('No front or rear image on this device type')
        return render(
            request,
            self.template_name,
            {
                'device_type': device_type,
                'front_image_url': front_image_url,
                'rear_image_url': rear_image_url,
            },
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


class BarcodeManagerView(LoginRequiredMixin, View):
    template_name = 'netbox_innovace_fibre/barcode_manager.html'

    def get(self, request):
        return render(request, self.template_name)


class BarcodeCsvImportView(LoginRequiredMixin, View):
    """
    POST multipart/form-data with:
      tab=devices|cables
      file=<csv file upload>
    Returns JSON: {imported: N, errors: [...]}
    """

    def post(self, request):
        tab = request.POST.get('tab', 'devices')
        upload = request.FILES.get('file')
        if not upload:
            return JsonResponse({'error': 'No file uploaded'}, status=400)

        text = upload.read().decode('utf-8-sig', errors='replace')
        reader = csv.DictReader(io.StringIO(text))

        imported = 0
        errors = []

        if tab == 'devices':
            for i, row in enumerate(reader):
                name    = (row.get('name') or '').strip()
                barcode = (row.get('barcode') or '').strip()
                if not name:
                    errors.append({'row': i + 2, 'error': 'Missing name'})
                    continue
                device = Device.objects.filter(name=name).first()
                if not device:
                    errors.append({'row': i + 2, 'error': f'Device not found: {name!r}'})
                    continue
                if barcode:
                    dup = Device.objects.filter(
                        custom_field_data__iff_barcode=barcode
                    ).exclude(pk=device.pk).first()
                    if dup:
                        errors.append({'row': i + 2, 'error': f'Barcode already used by {dup.name}'})
                        continue
                device.custom_field_data['iff_barcode'] = barcode or None
                device.save(update_fields=['custom_field_data'])
                imported += 1

        elif tab == 'cables':
            for i, row in enumerate(reader):
                label     = (row.get('label') or '').strip()
                barcode_a = (row.get('barcode_a') or '').strip() or None
                barcode_b = (row.get('barcode_b') or '').strip() or None
                if not label:
                    errors.append({'row': i + 2, 'error': 'Missing label'})
                    continue
                cable = Cable.objects.filter(label=label).first()
                if not cable:
                    errors.append({'row': i + 2, 'error': f'Cable not found: {label!r}'})
                    continue
                for field, value in [('iff_barcode_a', barcode_a), ('iff_barcode_b', barcode_b)]:
                    if value:
                        dup = Cable.objects.filter(
                            **{f'custom_field_data__{field}': value}
                        ).exclude(pk=cable.pk).first()
                        if dup:
                            errors.append({'row': i + 2, 'error': f'{field} already used by cable {dup.pk}'})
                            barcode_a = None if field == 'iff_barcode_a' else barcode_a
                            barcode_b = None if field == 'iff_barcode_b' else barcode_b
                cable.custom_field_data['iff_barcode_a'] = barcode_a
                cable.custom_field_data['iff_barcode_b'] = barcode_b
                cable.save(update_fields=['custom_field_data'])
                imported += 1

        return JsonResponse({'imported': imported, 'errors': errors})


class BarcodeCsvExportView(LoginRequiredMixin, View):
    """
    GET ?tab=devices|cables
    Returns a CSV file download.
    """

    def get(self, request):
        tab = request.GET.get('tab', 'devices')
        response = HttpResponse(content_type='text/csv; charset=utf-8')

        if tab == 'cables':
            response['Content-Disposition'] = 'attachment; filename="cable_barcodes.csv"'
            writer = csv.writer(response)
            writer.writerow(['label', 'a_device', 'a_port', 'b_device', 'b_port', 'barcode_a', 'barcode_b'])
            cables = Cable.objects.prefetch_related('terminations__termination').order_by('label', 'pk')
            for cable in cables:
                a_device, a_port, b_device, b_port = '', '', '', ''
                for ct in cable.terminations.all():
                    port = ct.termination
                    dev = getattr(port, 'device', None)
                    if ct.cable_end == 'A':
                        a_device = dev.name if dev else ''
                        a_port   = port.name if port else ''
                    else:
                        b_device = dev.name if dev else ''
                        b_port   = port.name if port else ''
                writer.writerow([
                    cable.label or '',
                    a_device, a_port, b_device, b_port,
                    cable.custom_field_data.get('iff_barcode_a') or '',
                    cable.custom_field_data.get('iff_barcode_b') or '',
                ])
        else:
            response['Content-Disposition'] = 'attachment; filename="device_barcodes.csv"'
            writer = csv.writer(response)
            writer.writerow(['name', 'site', 'rack', 'barcode'])
            devices = (
                Device.objects
                .select_related('site', 'rack')
                .order_by('name')
            )
            for device in devices:
                writer.writerow([
                    device.name or '',
                    device.site.name if device.site_id else '',
                    device.rack.name if device.rack_id else '',
                    device.custom_field_data.get('iff_barcode') or '',
                ])

        return response
