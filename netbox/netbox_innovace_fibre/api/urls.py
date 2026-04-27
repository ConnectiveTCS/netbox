from django.urls import path
from rest_framework.routers import DefaultRouter

from .views import DeviceTypeSignalMetaViewSet, SignalRoutingViewSet, SignalTraceAPIView

router = DefaultRouter()
router.register('device-type-signal-meta', DeviceTypeSignalMetaViewSet)
router.register('signal-routings', SignalRoutingViewSet)

urlpatterns = [
    path('trace/device-type/<int:pk>/', SignalTraceAPIView.as_view(), name='signal-trace'),
]
urlpatterns += router.urls
