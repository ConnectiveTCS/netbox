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
        )),
    ),
    icon_class='mdi mdi-lan',
)
