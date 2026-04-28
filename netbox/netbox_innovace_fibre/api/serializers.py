from rest_framework import serializers

from netbox_innovace_fibre.models import DeviceSignalRouting, DeviceTypeSignalMeta, SignalRouting


class DeviceTypeSignalMetaSerializer(serializers.ModelSerializer):
    class Meta:
        model = DeviceTypeSignalMeta
        fields = (
            'id',
            'device_type',
            'fibre_viz_type_id',
            'category',
            'mount_type',
            'splitter_ratio',
            'is_configurable',
        )


class SignalRoutingSerializer(serializers.ModelSerializer):
    class Meta:
        model = SignalRouting
        fields = (
            'id',
            'device_type',
            'from_port_name',
            'from_signal',
            'to_port_name',
            'to_signal',
            'is_bidirectional',
        )


class DeviceSignalRoutingSerializer(serializers.ModelSerializer):
    class Meta:
        model = DeviceSignalRouting
        fields = (
            'id',
            'device',
            'from_port_name',
            'from_signal',
            'to_port_name',
            'to_signal',
            'is_bidirectional',
        )
