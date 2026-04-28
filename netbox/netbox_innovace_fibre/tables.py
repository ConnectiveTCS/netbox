import django_tables2 as tables
from django.urls import reverse
from django.utils.html import format_html

from dcim.models import Device

__all__ = ('DeviceCustomMappingTable',)

MANAGE_BUTTON = """
<a href="{url}" class="btn btn-sm btn-primary">
  <i class="mdi mdi-map-marker-path"></i> Manage
</a>
"""


class OverrideCountColumn(tables.Column):
    """Shows a badge with the number of device-level signal routing overrides."""

    def __init__(self, *args, **kwargs):
        kwargs.setdefault('orderable', True)
        kwargs.setdefault('verbose_name', 'Overrides')
        super().__init__(*args, **kwargs)

    def render(self, value):
        if value:
            return format_html(
                '<span class="badge text-bg-primary">{}</span>', value
            )
        return format_html('<span class="badge text-bg-secondary">0</span>')


class ManageColumn(tables.Column):
    """Action button linking to the device signal-routings page."""

    def __init__(self, *args, **kwargs):
        kwargs['orderable'] = False
        kwargs['verbose_name'] = 'Actions'
        kwargs['empty_values'] = ()
        kwargs.setdefault('attrs', {'td': {'class': 'text-end text-nowrap'}})
        super().__init__(*args, **kwargs)

    def render(self, record):
        url = reverse(
            'plugins:netbox_innovace_fibre:device_signal_routing',
            kwargs={'pk': record.pk},
        )
        return format_html(
            '<a href="{}" class="btn btn-sm btn-primary">'
            '<i class="mdi mdi-map-marker-path"></i> Manage</a>',
            url,
        )


class DeviceCustomMappingTable(tables.Table):
    name = tables.Column(
        verbose_name='Device',
        linkify=lambda record: record.get_absolute_url(),
    )
    site = tables.Column(
        verbose_name='Site',
        linkify=True,
    )
    rack = tables.Column(
        verbose_name='Rack',
        linkify=True,
    )
    device_type = tables.Column(
        verbose_name='Device Type',
        linkify=True,
    )
    status = tables.Column(verbose_name='Status')
    override_count = OverrideCountColumn(accessor='override_count')
    manage = ManageColumn()

    class Meta:
        model = Device
        fields = ('name', 'site', 'rack', 'device_type', 'status', 'override_count', 'manage')
        attrs = {'class': 'table table-hover object-list'}
        empty_text = 'No devices found.'
