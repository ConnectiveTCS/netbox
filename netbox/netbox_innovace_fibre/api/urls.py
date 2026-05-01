from django.urls import path
from rest_framework.routers import DefaultRouter

from .views import (
    BarcodeBulkAssignAPIView,
    BarcodeLookupAPIView,
    BayLayoutAPIView,
    DeviceSignalRoutingViewSet,
    DeviceSignalTraceAPIView,
    DeviceTypeSignalMetaViewSet,
    FloorPlanAPIView,
    FullTraceAPIView,
    PortLayoutAPIView,
    PortLayoutListAPIView,
    Rack3DDataAPIView,
    RackListAPIView,
    SignalRoutingViewSet,
    SignalTraceAPIView,
    TopologyDataAPIView,
    TopologyLayoutAPIView,
)

router = DefaultRouter()
router.register('device-type-signal-meta', DeviceTypeSignalMetaViewSet)
router.register('signal-routings', SignalRoutingViewSet)
router.register('device-signal-routings', DeviceSignalRoutingViewSet)

urlpatterns = [
    path('trace/device-type/<int:pk>/', SignalTraceAPIView.as_view(), name='signal-trace'),
    path('trace/device/<int:pk>/', DeviceSignalTraceAPIView.as_view(), name='device-signal-trace'),
    path('trace/full/', FullTraceAPIView.as_view(), name='full-trace'),
    path('topology/', TopologyDataAPIView.as_view(), name='topology-data'),
    path('topology-layout/', TopologyLayoutAPIView.as_view(), name='topology-layout'),
    path('racks/', RackListAPIView.as_view(), name='rack-list'),
    path('racks/<int:pk>/3d-data/', Rack3DDataAPIView.as_view(), name='rack-3d-data'),
    path('devices/<int:pk>/bay-layout/', BayLayoutAPIView.as_view(), name='bay-layout'),
    path('floor-plan/', FloorPlanAPIView.as_view(), name='floor-plan'),
    # Port layout editor API (must come before the <int:pk> route to avoid ambiguity)
    path('device-types/port-layout-list/', PortLayoutListAPIView.as_view(), name='port-layout-list'),
    path('device-types/<int:pk>/port-layout/', PortLayoutAPIView.as_view(), name='port-layout'),
    path('barcode-lookup/', BarcodeLookupAPIView.as_view(), name='barcode-lookup'),
    path('barcode-bulk-assign/', BarcodeBulkAssignAPIView.as_view(), name='barcode-bulk-assign'),
]
urlpatterns += router.urls
