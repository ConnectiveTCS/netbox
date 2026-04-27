from netbox.plugins import PluginConfig


class NetBoxInnovaceFibreConfig(PluginConfig):
    name = 'netbox_innovace_fibre'
    verbose_name = 'Innovace Fibre'
    description = 'Signal-level routing and tracing for Innovace fibre device types.'
    version = '0.1.0'
    base_url = 'innovace-fibre'
    min_version = '4.2.0'
    max_version = '4.99'


config = NetBoxInnovaceFibreConfig
