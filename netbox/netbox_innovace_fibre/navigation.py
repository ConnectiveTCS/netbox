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
        )),
    ),
    icon_class='mdi mdi-lan',
)
