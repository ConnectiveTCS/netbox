from django.urls import path
from rest_framework.routers import DefaultRouter

from .views import (
    DeviceSignalRoutingViewSet,
    DeviceSignalTraceAPIView,
    DeviceTypeSignalMetaViewSet,
    FloorPlanAPIView,
    Rack3DDataAPIView,
    RackListAPIView,
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
    path('racks/', RackListAPIView.as_view(), name='rack-list'),
    path('racks/<int:pk>/3d-data/', Rack3DDataAPIView.as_view(), name='rack-3d-data'),
    path('floor-plan/', FloorPlanAPIView.as_view(), name='floor-plan'),
]
urlpatterns += router.urls
