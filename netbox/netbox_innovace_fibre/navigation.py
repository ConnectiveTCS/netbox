from netbox.plugins.navigation import PluginMenu, PluginMenuItem

menu = PluginMenu(
    label='Innovace Fibre',
    groups=(
        ('Fibre', (
            PluginMenuItem(
                link='plugins:netbox_innovace_fibre:topology',
                link_text='Topology',
            ),
            PluginMenuItem(
                link='plugins:netbox_innovace_fibre:custom_mapping_list',
                link_text='Custom Mapping',
            ),
            PluginMenuItem(
                link='plugins:netbox_innovace_fibre:rack_3d',
                link_text='3D Rack View',
            ),
            PluginMenuItem(
                link='plugins:netbox_innovace_fibre:port_layout_list',
                link_text='Port Layout Editor',
            ),
            PluginMenuItem(
                link='plugins:netbox_innovace_fibre:barcode_manager',
                link_text='Barcode Manager',
            ),
            PluginMenuItem(
                link='plugins:netbox_innovace_fibre:import_manager',
                link_text='Import Manager',
            ),
        )),
    ),
    icon_class='mdi mdi-lan',
)
