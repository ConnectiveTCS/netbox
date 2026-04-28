from django.urls import path

from . import views

app_name = 'netbox_innovace_fibre'

urlpatterns = [
    path('racks/3d/', views.Rack3DView.as_view(), name='rack_3d'),
    path('topology/', views.TopologyView.as_view(), name='topology'),
    path('custom-mapping/', views.CustomMappingListView.as_view(), name='custom_mapping_list'),
    path('device-types/<int:pk>/schematic/', views.DeviceTypeSchematicView.as_view(), name='device_type_schematic'),
    path('device-types/<int:pk>/signal-trace/', views.SignalTraceView.as_view(), name='signal_trace'),
    path('devices/<int:pk>/signal-routings/', views.DeviceSignalRoutingView.as_view(), name='device_signal_routing'),
    path('devices/<int:pk>/signal-routings/<int:route_pk>/delete/', views.DeviceSignalRoutingDeleteView.as_view(), name='device_signal_routing_delete'),
    path('devices/<int:pk>/signal-trace/', views.DeviceSignalTraceView.as_view(), name='device_signal_trace'),
]
