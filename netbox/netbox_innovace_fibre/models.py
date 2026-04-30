from django.contrib.auth import get_user_model
from django.db import models
from django.utils.translation import gettext_lazy as _

from dcim.models import Device, DeviceType, Site
from utilities.querysets import RestrictedQuerySet


class DeviceTypeSignalMeta(models.Model):
    objects = RestrictedQuerySet.as_manager()

    CATEGORY_CASSETTE = 'cassette'
    CATEGORY_DEVICE = 'device'
    CATEGORY_SWITCH = 'switch'
    CATEGORY_INFRASTRUCTURE = 'infrastructure'
    CATEGORY_SERVER = 'server'
    CATEGORY_TEST_EQUIPMENT = 'test_equipment'

    MOUNT_RACK = 'rack'
    MOUNT_CHASSIS_ONLY = 'chassis_only'
    MOUNT_NON_RACKABLE = 'non_rackable'

    CATEGORY_CHOICES = (
        (CATEGORY_CASSETTE, 'Cassette'),
        (CATEGORY_DEVICE, 'Device'),
        (CATEGORY_SWITCH, 'Switch'),
        (CATEGORY_INFRASTRUCTURE, 'Infrastructure'),
        (CATEGORY_SERVER, 'Server'),
        (CATEGORY_TEST_EQUIPMENT, 'Test Equipment'),
    )

    MOUNT_TYPE_CHOICES = (
        (MOUNT_RACK, 'Rack'),
        (MOUNT_CHASSIS_ONLY, 'Chassis Only'),
        (MOUNT_NON_RACKABLE, 'Non-Rackable'),
    )

    device_type = models.OneToOneField(
        to=DeviceType,
        on_delete=models.CASCADE,
        related_name='innovace_signal_meta',
    )
    fibre_viz_type_id = models.CharField(max_length=50, unique=True)
    category = models.CharField(max_length=30, choices=CATEGORY_CHOICES, default=CATEGORY_DEVICE)
    mount_type = models.CharField(max_length=20, choices=MOUNT_TYPE_CHOICES, default=MOUNT_RACK)
    splitter_ratio = models.CharField(max_length=10, blank=True)
    is_configurable = models.BooleanField(default=False)

    class Meta:
        ordering = ('device_type__manufacturer__name', 'device_type__model')
        verbose_name = _('device type signal metadata')
        verbose_name_plural = _('device type signal metadata')

    def __str__(self):
        return f"{self.device_type}: {self.fibre_viz_type_id}"


class SignalRouting(models.Model):
    objects = RestrictedQuerySet.as_manager()

    device_type = models.ForeignKey(
        to=DeviceType,
        on_delete=models.CASCADE,
        related_name='innovace_signal_routings',
    )
    from_port_name = models.CharField(max_length=100)
    from_signal = models.PositiveSmallIntegerField(default=1)
    to_port_name = models.CharField(max_length=100)
    to_signal = models.PositiveSmallIntegerField(default=1)
    is_bidirectional = models.BooleanField(default=False)

    class Meta:
        ordering = ('device_type', 'from_port_name', 'from_signal', 'to_port_name', 'to_signal')
        constraints = (
            models.UniqueConstraint(
                fields=('device_type', 'from_port_name', 'from_signal', 'to_port_name', 'to_signal'),
                name='netbox_innovace_fibre_unique_signal_route',
            ),
        )
        verbose_name = _('signal routing')
        verbose_name_plural = _('signal routings')

    def __str__(self):
        arrow = '<->' if self.is_bidirectional else '->'
        return (
            f"{self.device_type} {self.from_port_name}:{self.from_signal} "
            f"{arrow} {self.to_port_name}:{self.to_signal}"
        )


class DeviceSignalRouting(models.Model):
    """
    Per-device signal routing override. When any rows exist for a device, the
    Innovace signal tracer uses these instead of the device type's SignalRouting
    entries. This allows individual devices (e.g. splitters) to carry custom
    1-to-N port mappings that differ from the device type default.
    """
    objects = RestrictedQuerySet.as_manager()

    device = models.ForeignKey(
        to=Device,
        on_delete=models.CASCADE,
        related_name='innovace_signal_routings',
    )
    from_port_name = models.CharField(max_length=100)
    from_signal = models.PositiveSmallIntegerField(default=1)
    to_port_name = models.CharField(max_length=100)
    to_signal = models.PositiveSmallIntegerField(default=1)
    is_bidirectional = models.BooleanField(default=False)

    class Meta:
        ordering = ('device', 'from_port_name', 'from_signal', 'to_port_name', 'to_signal')
        constraints = (
            models.UniqueConstraint(
                fields=('device', 'from_port_name', 'from_signal', 'to_port_name', 'to_signal'),
                name='netbox_innovace_fibre_unique_device_signal_route',
            ),
        )
        verbose_name = _('device signal routing')
        verbose_name_plural = _('device signal routings')

    def __str__(self):
        arrow = '<->' if self.is_bidirectional else '->'
        return (
            f"{self.device} {self.from_port_name}:{self.from_signal} "
            f"{arrow} {self.to_port_name}:{self.to_signal}"
        )


class FloorPlanVersion(models.Model):
    """
    Versioned floor plan layout for a site.
    Each Save creates a new row; history is preserved.
    The latest record (highest pk) for a site is the active layout.

    config JSON shape:
    {
      "floor": {"width": 200, "depth": 150, "gridSnap": 12, "unit": "in"},
      "racks": [{"rackId": 1, "x": 24.0, "z": 0.0, "orientation": "N"}],
      "railFL": 2, "railFR": 2, "railRL": 2, "railRR": 2
    }
    """
    objects = RestrictedQuerySet.as_manager()

    site = models.ForeignKey(
        to=Site,
        on_delete=models.CASCADE,
        related_name='innovace_floor_plans',
    )
    created_by = models.ForeignKey(
        to=get_user_model(),
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='+',
    )
    created_at = models.DateTimeField(auto_now_add=True)
    config = models.JSONField(default=dict)

    class Meta:
        ordering = ['-created_at']
        verbose_name = _('floor plan version')
        verbose_name_plural = _('floor plan versions')

    def __str__(self):
        return f"FloorPlan({self.site}, {self.created_at})"
