from django.urls import path

from . import views

app_name = 'netbox_innovace_fibre'

urlpatterns = [
    path('racks/3d/', views.Rack3DView.as_view(), name='rack_3d'),
    path('port-layout/', views.PortLayoutListView.as_view(), name='port_layout_list'),
    path('device-types/<int:pk>/port-layout/', views.PortLayoutEditorView.as_view(), name='port_layout_editor'),
    path('devices/<int:pk>/bay-layout/', views.PatchEnclosureBayLayoutView.as_view(), name='patch_enclosure_bay_layout'),
    path('topology/', views.TopologyView.as_view(), name='topology'),
    path('custom-mapping/', views.CustomMappingListView.as_view(), name='custom_mapping_list'),
    path('device-types/<int:pk>/schematic/', views.DeviceTypeSchematicView.as_view(), name='device_type_schematic'),
    path('device-types/<int:pk>/signal-trace/', views.SignalTraceView.as_view(), name='signal_trace'),
    path('devices/<int:pk>/signal-routings/', views.DeviceSignalRoutingView.as_view(), name='device_signal_routing'),
    path('devices/<int:pk>/signal-routings/link-to-device-type/', views.DeviceSignalRoutingLinkToTypeView.as_view(), name='device_signal_routing_link_to_type'),
    path('devices/<int:pk>/signal-routings/clone-to-similar/', views.DeviceSignalRoutingCloneToSimilarView.as_view(), name='device_signal_routing_clone_to_similar'),
    path('devices/<int:pk>/signal-routings/<int:route_pk>/delete/', views.DeviceSignalRoutingDeleteView.as_view(), name='device_signal_routing_delete'),
    path('devices/<int:pk>/signal-trace/', views.DeviceSignalTraceView.as_view(), name='device_signal_trace'),
    path('barcode-manager/', views.BarcodeManagerView.as_view(), name='barcode_manager'),
    path('barcode-manager/import/', views.BarcodeCsvImportView.as_view(), name='barcode_csv_import'),
    path('barcode-manager/export/', views.BarcodeCsvExportView.as_view(), name='barcode_csv_export'),
    path('import-manager/', views.ImportManagerView.as_view(), name='import_manager'),
    path('import-manager/options/', views.ImportManagerOptionsView.as_view(), name='import_manager_options'),
    path('import-manager/devices/bulk-create/', views.DeviceBulkCreateView.as_view(), name='device_bulk_create'),
    path('import-manager/device-template.csv', views.DeviceImportTemplateCsvView.as_view(), name='device_import_template_csv'),
]
