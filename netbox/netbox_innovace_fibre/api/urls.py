from django.urls import path
from rest_framework.routers import DefaultRouter

from .views import DeviceTypeSignalMetaViewSet, SignalRoutingViewSet, SignalTraceAPIView, TopologyDataAPIView

router = DefaultRouter()
router.register('device-type-signal-meta', DeviceTypeSignalMetaViewSet)
router.register('signal-routings', SignalRoutingViewSet)

urlpatterns = [
    path('trace/device-type/<int:pk>/', SignalTraceAPIView.as_view(), name='signal-trace'),
    path('topology/', TopologyDataAPIView.as_view(), name='topology-data'),
]
urlpatterns += router.urls
