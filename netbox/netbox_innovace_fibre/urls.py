from django.urls import path

from . import views

app_name = 'netbox_innovace_fibre'

urlpatterns = [
    path('device-types/<int:pk>/schematic/', views.DeviceTypeSchematicView.as_view(), name='device_type_schematic'),
    path('device-types/<int:pk>/signal-trace/', views.SignalTraceView.as_view(), name='signal_trace'),
]
