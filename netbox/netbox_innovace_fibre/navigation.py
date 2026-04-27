from netbox.plugins.navigation import PluginMenu, PluginMenuItem

menu = PluginMenu(
    label='Innovace Fibre',
    groups=(
        ('Fibre', (
            PluginMenuItem(
                link='plugins:netbox_innovace_fibre:topology',
                link_text='Topology',
            ),
        )),
    ),
    icon_class='mdi mdi-lan',
)
