import csv
import decimal
import io
import json

from django.contrib import messages
from django.contrib.auth.mixins import LoginRequiredMixin
from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.db.utils import IntegrityError
from django.db.models import Count, Q
from django.http import Http404, HttpResponse, HttpResponseRedirect, JsonResponse
from django.shortcuts import get_object_or_404, render
from django.urls import NoReverseMatch, reverse
from django.views import View

from dcim.choices import DeviceFaceChoices, DeviceStatusChoices, SubdeviceRoleChoices
from dcim.forms.bulk_import import DeviceImportForm
from dcim.models import Cable, CableTermination, Device, DeviceBay, DeviceRole, DeviceType, Location, Manufacturer, Rack, Site
from utilities.permissions import get_permission_for_model

from .forms import DeviceSignalRoutingForm
from .models import DeviceSignalRouting, SignalRouting
from .tables import DeviceCustomMappingTable
from .tracer import trace_signal_path, trace_signal_path_for_device


DEVICE_IMPORT_TEMPLATE_FIELDS = tuple(DeviceImportForm.Meta.fields)
DEVICE_BULK_CREATE_FIELDS = (
    'name', 'role', 'manufacturer', 'device_type', 'status', 'site', 'location', 'rack',
    'position', 'face', 'serial', 'asset_tag', 'description',
)
DEVICE_BULK_CREATE_FORM_FIELDS = DEVICE_BULK_CREATE_FIELDS + ('parent', 'device_bay')
DEVICE_IMPORT_TEMPLATE_ROWS = (
    {
        'name': 'dc1-leaf-01',
        'role': 'Leaf Switch',
        'manufacturer': 'Innovace',
        'device_type': 'Leaf Switch 48x25G',
        'status': 'active',
        'site': 'Datacenter 1',
        'rack': 'R101',
        'position': '42',
        'face': 'front',
        'description': 'Sample leaf switch',
    },
    {
        'name': 'dc1-patch-01',
        'role': 'Patch Panel',
        'manufacturer': 'Innovace',
        'device_type': 'Fibre Patch Panel 1U',
        'status': 'active',
        'site': 'Datacenter 1',
        'rack': 'R101',
        'position': '41',
        'face': 'front',
        'description': 'Sample fibre patch panel',
    },
)


def _choice_options(choices):
    return [
        {'value': value, 'label': str(label)}
        for value, label, *_ in choices
    ]


def _model_options(queryset, label_attr='name'):
    return [
        {'id': obj.pk, 'value': getattr(obj, label_attr), 'label': getattr(obj, label_attr)}
        for obj in queryset
    ]


def _field_errors(form):
    errors = []
    for field_name, field_errors in form.errors.items():
        label = field_name if field_name != '__all__' else 'row'
        for error in field_errors:
            errors.append(f'{label}: {error}')
    return errors


def _is_empty_device_row(row):
    return not any((row.get(field) or '').strip() for field in DEVICE_BULK_CREATE_FORM_FIELDS)


def _device_bay_option(bay):
    parent = bay.device
    site = parent.site
    rack = parent.rack
    return {
        'id': bay.pk,
        'value': bay.name,
        'label': f'{parent.name or parent} / {bay.name}',
        'name': bay.name,
        'parent_id': parent.pk,
        'parent_name': parent.name or str(parent),
        'site_id': site.pk if site else None,
        'site': site.name if site else '',
        'rack_id': rack.pk if rack else None,
        'rack': rack.name if rack else '',
        'occupied': bool(bay.installed_device_id),
    }


def _decimal_unit(value):
    try:
        return decimal.Decimal(str(value))
    except (decimal.InvalidOperation, TypeError, ValueError):
        return None


def _unit_label(value):
    unit = _decimal_unit(value)
    if unit is None:
        return ''
    return str(int(unit)) if unit == unit.to_integral_value() else str(unit)


def _safe_image_url(image_field):
    """Return a file URL for an ImageField/FileField, or None if unavailable."""
    if not image_field:
        return None
    try:
        return image_field.url
    except ValueError:
        return None


def _cable_barcode_conflict(barcode, cable_id):
    if not barcode:
        return None
    return (
        Cable.objects
        .filter(
            Q(custom_field_data__iff_barcode_a=barcode) |
            Q(custom_field_data__iff_barcode_b=barcode)
        )
        .exclude(pk=cable_id)
        .first()
    )


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
        similar_devices = Device.objects.filter(device_type=device.device_type).exclude(pk=device.pk)
        form = DeviceSignalRoutingForm()
        return render(
            request,
            self.template_name,
            {
                'device': device,
                'overrides': overrides,
                'type_defaults': type_defaults,
                'similar_device_count': similar_devices.count(),
                'similar_devices_with_overrides_count': similar_devices.filter(
                    innovace_signal_routings__isnull=False
                ).distinct().count(),
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


class DeviceSignalRoutingLinkToTypeView(View):
    """Replaces a device type's default signal routings with one device's overrides."""

    def post(self, request, pk):
        device = get_object_or_404(Device, pk=pk)
        overrides = list(DeviceSignalRouting.objects.filter(device=device))

        if not overrides:
            messages.warning(request, 'Add at least one override before linking it to the device type.')
            return HttpResponseRedirect(
                reverse('plugins:netbox_innovace_fibre:device_signal_routing', kwargs={'pk': pk})
            )

        with transaction.atomic():
            SignalRouting.objects.filter(device_type=device.device_type).delete()
            SignalRouting.objects.bulk_create([
                SignalRouting(
                    device_type=device.device_type,
                    from_port_name=route.from_port_name,
                    from_signal=route.from_signal,
                    to_port_name=route.to_port_name,
                    to_signal=route.to_signal,
                    is_bidirectional=route.is_bidirectional,
                )
                for route in overrides
            ])

        messages.success(
            request,
            f'Linked {len(overrides)} override(s) from {device} to device type {device.device_type}.',
        )
        return HttpResponseRedirect(
            reverse('plugins:netbox_innovace_fibre:device_signal_routing', kwargs={'pk': pk})
        )


class DeviceSignalRoutingCloneToSimilarView(View):
    """Copies a device's signal routing overrides to other devices of the same device type."""

    def post(self, request, pk):
        device = get_object_or_404(Device, pk=pk)
        overrides = list(DeviceSignalRouting.objects.filter(device=device))
        similar_devices = list(Device.objects.filter(device_type=device.device_type).exclude(pk=device.pk))

        if not overrides:
            messages.warning(request, 'Add at least one override before cloning it to similar devices.')
            return HttpResponseRedirect(
                reverse('plugins:netbox_innovace_fibre:device_signal_routing', kwargs={'pk': pk})
            )

        if not similar_devices:
            messages.info(request, f'No other devices use device type {device.device_type}.')
            return HttpResponseRedirect(
                reverse('plugins:netbox_innovace_fibre:device_signal_routing', kwargs={'pk': pk})
            )

        with transaction.atomic():
            DeviceSignalRouting.objects.filter(device__in=similar_devices).delete()
            DeviceSignalRouting.objects.bulk_create([
                DeviceSignalRouting(
                    device=target_device,
                    from_port_name=route.from_port_name,
                    from_signal=route.from_signal,
                    to_port_name=route.to_port_name,
                    to_signal=route.to_signal,
                    is_bidirectional=route.is_bidirectional,
                )
                for target_device in similar_devices
                for route in overrides
            ])

        messages.success(
            request,
            f'Cloned {len(overrides)} override(s) to {len(similar_devices)} similar device(s).',
        )
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
            DeviceType.objects.select_related('manufacturer')
            .prefetch_related('rearporttemplates'),
            pk=pk,
        )
        front_image_url = _safe_image_url(device_type.front_image)
        rear_image_url = _safe_image_url(device_type.rear_image)
        has_rear_ports = device_type.rearporttemplates.exists()
        if not front_image_url and not rear_image_url and not has_rear_ports:
            raise Http404('No front or rear image or rear ports on this device type')
        return render(
            request,
            self.template_name,
            {
                'device_type': device_type,
                'front_image_url': front_image_url,
                'rear_image_url': rear_image_url,
                'has_rear_ports': has_rear_ports,
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


class ImportManagerView(LoginRequiredMixin, View):
    template_name = 'netbox_innovace_fibre/import_manager.html'

    def get(self, request):
        try:
            device_import_url = reverse('dcim:device_bulk_import')
        except NoReverseMatch:
            device_import_url = None

        return render(
            request,
            self.template_name,
            {
                'device_bulk_create_fields': DEVICE_BULK_CREATE_FIELDS,
                'device_import_template_fields': DEVICE_IMPORT_TEMPLATE_FIELDS,
                'device_import_url': device_import_url,
            },
        )


class ImportManagerOptionsView(LoginRequiredMixin, View):
    def get(self, request):
        manufacturer_id = request.GET.get('manufacturer_id')
        site_id = request.GET.get('site_id')
        location_id = request.GET.get('location_id')
        query = (request.GET.get('q') or '').strip()

        device_types = DeviceType.objects.select_related('manufacturer').order_by('manufacturer__name', 'model')
        if manufacturer_id:
            device_types = device_types.filter(manufacturer_id=manufacturer_id)
        if query:
            device_types = device_types.filter(model__icontains=query)

        locations = Location.objects.select_related('site').order_by('site__name', 'name')
        if site_id:
            locations = locations.filter(site_id=site_id)

        racks = Rack.objects.select_related('site', 'location').order_by('site__name', 'name')
        if site_id:
            racks = racks.filter(site_id=site_id)
        if location_id:
            racks = racks.filter(location_id=location_id)
        elif site_id:
            racks = racks.filter(Q(location__isnull=True) | Q(location__site_id=site_id))

        parent_devices = (
            Device.objects
            .filter(devicebays__isnull=False)
            .select_related('site', 'rack', 'device_type__manufacturer')
            .distinct()
            .order_by('site__name', 'name')
        )
        if site_id:
            parent_devices = parent_devices.filter(site_id=site_id)
        if location_id:
            parent_devices = parent_devices.filter(location_id=location_id)

        device_bays = (
            DeviceBay.objects
            .select_related('device__site', 'device__rack', 'installed_device')
            .filter(device__in=parent_devices)
            .order_by('device__name', 'name')
        )

        existing_child_devices = (
            Device.objects
            .filter(
                parent_bay__isnull=True,
                device_type__u_height=0,
                device_type__subdevice_role=SubdeviceRoleChoices.ROLE_CHILD,
            )
            .select_related('site', 'rack', 'device_type__manufacturer')
            .order_by('site__name', 'name')
        )
        if site_id:
            existing_child_devices = existing_child_devices.filter(site_id=site_id)
        if location_id:
            existing_child_devices = existing_child_devices.filter(location_id=location_id)

        return JsonResponse({
            'roles': _model_options(DeviceRole.objects.order_by('name')),
            'manufacturers': _model_options(Manufacturer.objects.order_by('name')),
            'device_types': [
                {
                    'id': device_type.pk,
                    'value': device_type.model,
                    'label': device_type.model,
                    'manufacturer_id': device_type.manufacturer_id,
                    'manufacturer': device_type.manufacturer.name,
                }
                for device_type in device_types[:500]
            ],
            'statuses': _choice_options(DeviceStatusChoices),
            'sites': _model_options(Site.objects.order_by('name')),
            'locations': [
                {
                    'id': location.pk,
                    'value': location.name,
                    'label': location.name,
                    'site_id': location.site_id,
                    'site': location.site.name,
                }
                for location in locations[:500]
            ],
            'racks': [
                {
                    'id': rack.pk,
                    'value': rack.name,
                    'label': rack.name,
                    'site_id': rack.site_id,
                    'site': rack.site.name,
                    'location_id': rack.location_id,
                }
                for rack in racks[:500]
            ],
            'faces': _choice_options(DeviceFaceChoices),
            'parent_devices': [
                {
                    'id': device.pk,
                    'value': device.name or str(device),
                    'label': device.name or str(device),
                    'site_id': device.site_id,
                    'site': device.site.name if device.site_id else '',
                    'rack_id': device.rack_id,
                    'rack': device.rack.name if device.rack_id else '',
                    'device_type': device.device_type.model if device.device_type_id else '',
                }
                for device in parent_devices[:500]
            ],
            'device_bays': [
                _device_bay_option(bay)
                for bay in device_bays[:1000]
            ],
            'existing_child_devices': [
                {
                    'id': device.pk,
                    'value': device.name or str(device),
                    'label': device.name or str(device),
                    'site_id': device.site_id,
                    'site': device.site.name if device.site_id else '',
                    'rack_id': device.rack_id,
                    'rack': device.rack.name if device.rack_id else '',
                    'device_type': device.device_type.model if device.device_type_id else '',
                }
                for device in existing_child_devices[:1000]
            ],
        })


class RackUAvailabilityView(LoginRequiredMixin, View):
    def post(self, request):
        try:
            payload = json.loads(request.body.decode('utf-8') or '{}')
        except json.JSONDecodeError:
            return JsonResponse({'error': 'Invalid JSON payload'}, status=400)

        site_id = payload.get('site_id')
        rack_ids = payload.get('rack_ids') or []
        faces = payload.get('faces') or []

        if not site_id:
            return JsonResponse({'error': 'site_id is required'}, status=400)
        if not isinstance(rack_ids, list) or not rack_ids:
            return JsonResponse({'error': 'rack_ids must be a non-empty list'}, status=400)
        if not isinstance(faces, list) or not faces:
            return JsonResponse({'error': 'faces must be a non-empty list'}, status=400)

        valid_faces = {DeviceFaceChoices.FACE_FRONT, DeviceFaceChoices.FACE_REAR}
        faces = [face for face in faces if face in valid_faces]
        if not faces:
            return JsonResponse({'error': 'Select at least one valid rack face'}, status=400)

        racks = (
            Rack.objects
            .select_related('site', 'location')
            .prefetch_related('reservations')
            .filter(site_id=site_id, pk__in=rack_ids)
            .order_by('site__name', 'name')
        )

        rows = []
        for rack in racks:
            reserved_units = {
                unit
                for unit in (_decimal_unit(unit) for unit in rack.get_reserved_units().keys())
                if unit is not None
            }
            for face in faces:
                available_units = rack.get_available_units(u_height=1.0, rack_face=face)
                for unit in sorted(available_units, reverse=True):
                    unit = _decimal_unit(unit)
                    if unit is None or unit != unit.to_integral_value() or unit in reserved_units:
                        continue
                    rows.append({
                        'site': rack.site.name if rack.site_id else '',
                        'site_id': rack.site_id,
                        'location': rack.location.name if rack.location_id else '',
                        'location_id': rack.location_id,
                        'rack': rack.name,
                        'rack_id': rack.pk,
                        'rack_label': f'{rack.site.name} / {rack.name}' if rack.site_id else rack.name,
                        'position': _unit_label(unit),
                        'face': face,
                    })

        return JsonResponse({'rows': rows, 'count': len(rows)})


class DeviceBulkCreateView(LoginRequiredMixin, View):
    def post(self, request):
        if not request.user.has_perm(get_permission_for_model(Device, 'add')):
            raise PermissionDenied

        try:
            payload = json.loads(request.body.decode('utf-8') or '{}')
        except json.JSONDecodeError:
            return JsonResponse({'error': 'Invalid JSON payload'}, status=400)

        rows = payload.get('rows')
        if not isinstance(rows, list):
            return JsonResponse({'error': 'Expected a rows list'}, status=400)

        prepared_rows = []
        for row_index, row in enumerate(rows):
            if not isinstance(row, dict) or _is_empty_device_row(row):
                continue
            prepared_rows.append((row_index, {
                field: (row.get(field) or '').strip()
                for field in DEVICE_BULK_CREATE_FORM_FIELDS
            }))

        if not prepared_rows:
            return JsonResponse({'created': 0, 'results': [], 'errors': ['No device rows to create']}, status=400)

        forms = []
        results = [
            {'row': row_index, 'status': 'pending', 'errors': []}
            for row_index, _ in prepared_rows
        ]
        has_errors = False

        for result, (_, row_data) in zip(results, prepared_rows):
            form = DeviceImportForm(data=row_data, instance=Device())
            if form.is_valid():
                forms.append((result, form))
            else:
                result['status'] = 'error'
                result['errors'] = _field_errors(form)
                has_errors = True

        if has_errors:
            return JsonResponse({'created': 0, 'results': results}, status=400)

        try:
            with transaction.atomic():
                created = []
                for result, form in forms:
                    parent_bay = getattr(form.instance, 'parent_bay', None)
                    device = form.save()

                    if parent_bay:
                        parent_bay.snapshot()
                        parent_bay.installed_device = device
                        parent_bay.save()

                    if not Device.objects.restrict(request.user, 'add').filter(pk=device.pk).exists():
                        raise PermissionDenied

                    created.append(device)
                    result.update({
                        'status': 'created',
                        'id': device.pk,
                        'name': device.name,
                        'url': device.get_absolute_url(),
                        'errors': [],
                    })
        except PermissionDenied:
            raise
        except (IntegrityError, ValidationError) as error:
            return JsonResponse({
                'created': 0,
                'results': [
                    {**result, 'status': 'error', 'errors': [str(error)]}
                    for result in results
                ],
            }, status=400)

        return JsonResponse({'created': len(created), 'results': results})


class DeviceBayBulkPopulateView(LoginRequiredMixin, View):
    def post(self, request):
        if not request.user.has_perm(get_permission_for_model(DeviceBay, 'change')):
            raise PermissionDenied

        try:
            payload = json.loads(request.body.decode('utf-8') or '{}')
        except json.JSONDecodeError:
            return JsonResponse({'error': 'Invalid JSON payload'}, status=400)

        rows = payload.get('rows')
        if not isinstance(rows, list):
            return JsonResponse({'error': 'Expected a rows list'}, status=400)

        results = []
        prepared = []
        has_errors = False

        for row_index, row in enumerate(rows):
            if not isinstance(row, dict):
                continue
            device_id = row.get('device_id')
            bay_id = row.get('device_bay_id')
            if not device_id and not bay_id:
                continue

            result = {'row': row_index, 'status': 'pending', 'errors': []}
            results.append(result)

            try:
                device = Device.objects.select_related('site', 'rack', 'device_type').get(pk=device_id)
                bay = DeviceBay.objects.select_related('device__site', 'device__rack', 'installed_device').get(pk=bay_id)
                _validate_existing_device_bay_population(device, bay)
            except (Device.DoesNotExist, DeviceBay.DoesNotExist, ValidationError) as error:
                result['status'] = 'error'
                result['errors'] = error.messages if isinstance(error, ValidationError) else [str(error)]
                has_errors = True
                continue

            prepared.append((result, device, bay))

        if not results:
            return JsonResponse({'populated': 0, 'results': [], 'errors': ['No bay rows to populate']}, status=400)

        if has_errors:
            return JsonResponse({'populated': 0, 'results': results}, status=400)

        with transaction.atomic():
            for result, device, bay in prepared:
                bay.snapshot()
                bay.installed_device = device
                bay.save()
                result.update({
                    'status': 'populated',
                    'device_id': device.pk,
                    'device_name': device.name or str(device),
                    'device_url': device.get_absolute_url(),
                    'device_bay_id': bay.pk,
                    'device_bay_name': bay.name,
                    'parent_name': bay.device.name or str(bay.device),
                    'errors': [],
                })

        return JsonResponse({'populated': len(prepared), 'results': results})


def _validate_existing_device_bay_population(device, bay):
    if bay.installed_device_id:
        raise ValidationError(f'Device bay {bay.device} / {bay.name} is already occupied.')
    if device.pk == bay.device_id:
        raise ValidationError('A device cannot be installed into one of its own bays.')
    if device.parent_bay_id:
        raise ValidationError(f'Device {device} is already installed in a device bay.')
    if device.site_id != bay.device.site_id:
        raise ValidationError(f'Device {device} is not assigned to the same site as parent {bay.device}.')
    if device.rack_id != bay.device.rack_id:
        raise ValidationError(f'Device {device} is not assigned to the same rack as parent {bay.device}.')
    if not device.device_type.is_child_device or device.device_type.u_height != 0:
        raise ValidationError(f'Device {device} must use a 0U child device type.')


class DeviceImportTemplateCsvView(LoginRequiredMixin, View):
    def get(self, request):
        response = HttpResponse(content_type='text/csv; charset=utf-8')
        response['Content-Disposition'] = 'attachment; filename="innovace_device_import_template.csv"'

        writer = csv.DictWriter(response, fieldnames=DEVICE_IMPORT_TEMPLATE_FIELDS)
        writer.writeheader()
        for row in DEVICE_IMPORT_TEMPLATE_ROWS:
            writer.writerow({field: row.get(field, '') for field in DEVICE_IMPORT_TEMPLATE_FIELDS})

        return response


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
                has_conflict = False
                for field, value in [('barcode_a', barcode_a), ('barcode_b', barcode_b)]:
                    if value:
                        dup = _cable_barcode_conflict(value, cable.pk)
                        if dup:
                            errors.append({'row': i + 2, 'error': f'{field} already used by cable {dup.pk}'})
                            has_conflict = True
                if has_conflict:
                    continue
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
