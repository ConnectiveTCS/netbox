from django.urls import path
from rest_framework.routers import DefaultRouter

from .views import (
    DeviceSignalRoutingViewSet,
    DeviceSignalTraceAPIView,
    DeviceTypeSignalMetaViewSet,
    SignalRoutingViewSet,
    SignalTraceAPIView,
    TopologyDataAPIView,
)

router = DefaultRouter()
router.register('device-type-signal-meta', DeviceTypeSignalMetaViewSet)
router.register('signal-routings', SignalRoutingViewSet)
router.register('device-signal-routings', DeviceSignalRoutingViewSet)

urlpatterns = [
    path('trace/device-type/<int:pk>/', SignalTraceAPIView.as_view(), name='signal-trace'),
    path('trace/device/<int:pk>/', DeviceSignalTraceAPIView.as_view(), name='device-signal-trace'),
    path('topology/', TopologyDataAPIView.as_view(), name='topology-data'),
]
urlpatterns += router.urls
