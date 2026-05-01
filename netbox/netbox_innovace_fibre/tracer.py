from __future__ import annotations

from typing import Any

from dcim.models import Device, DeviceType

from .models import DeviceSignalRouting, SignalRouting


def _edge_payload(route: SignalRouting) -> dict[str, Any]:
    return {
        'from_port': route.from_port_name,
        'from_signal': route.from_signal,
        'to_port': route.to_port_name,
        'to_signal': route.to_signal,
        'is_bidirectional': route.is_bidirectional,
    }


def _logical_port_name(port_name: str | None) -> str:
    name = port_name or ''
    for suffix in ('_front', '_rear'):
        if name.lower().endswith(suffix):
            return name[:-len(suffix)]
    return name


def trace_signal_path(device_type: DeviceType, port_name: str | None, signal: int) -> list[list[dict[str, Any]]]:
    """
    Trace forward signal flow through a DeviceType's internal routing graph.

    Returns a list of branches, each branch being an ordered list of edges.
    """
    if not port_name:
        return []

    routes = list(SignalRouting.objects.filter(device_type=device_type))
    edge_map = _build_edge_map(routes)

    all_paths: list[list[dict[str, Any]]] = []
    visiting: set[tuple[str, int]] = set()

    def _walk(node_port: str, node_signal: int, path: list[dict[str, Any]]):
        node = (_logical_port_name(node_port), node_signal)
        if node in visiting:
            all_paths.append(path)
            return

        visiting.add(node)
        next_edges = edge_map.get(node, [])
        if not next_edges:
            all_paths.append(path)
            visiting.discard(node)
            return

        advanced = False
        for edge in next_edges:
            next_node = (_logical_port_name(edge.to_port_name), edge.to_signal)
            if next_node in visiting:
                continue
            advanced = True
            payload = _edge_payload(edge)
            _walk(edge.to_port_name, edge.to_signal, path + [payload])
        if not advanced:
            all_paths.append(path)

        visiting.discard(node)

    _walk(port_name, signal, [])
    return all_paths


def trace_to_origin(device_type: DeviceType, port_name: str | None, signal: int) -> list[list[dict[str, Any]]]:
    """
    Trace reverse signal flow by inverting the internal routing graph.

    Returns a list of branches ordered from origin to target.
    """
    if not port_name:
        return []

    routes = list(SignalRouting.objects.filter(device_type=device_type))
    reverse_edge_map = _build_reverse_edge_map(routes)

    all_paths: list[list[dict[str, Any]]] = []
    visiting: set[tuple[str, int]] = set()

    def _walk_reverse(node_port: str, node_signal: int, path: list[dict[str, Any]]):
        node = (_logical_port_name(node_port), node_signal)
        if node in visiting:
            all_paths.append(path)
            return

        visiting.add(node)
        next_edges = reverse_edge_map.get(node, [])
        if not next_edges:
            all_paths.append(path)
            visiting.discard(node)
            return

        for edge in next_edges:
            if _logical_port_name(edge.to_port_name) == _logical_port_name(node_port) and edge.to_signal == node_signal:
                payload = _edge_payload(edge)
                _walk_reverse(edge.from_port_name, edge.from_signal, [payload] + path)
            else:
                payload = {
                    'from_port': edge.to_port_name,
                    'from_signal': edge.to_signal,
                    'to_port': edge.from_port_name,
                    'to_signal': edge.from_signal,
                    'is_bidirectional': edge.is_bidirectional,
                }
                _walk_reverse(edge.to_port_name, edge.to_signal, [payload] + path)

        visiting.discard(node)

    _walk_reverse(port_name, signal, [])
    return all_paths


# ---------------------------------------------------------------------------
# Device-instance-level tracing
# ---------------------------------------------------------------------------

def _build_edge_map(routes: list) -> dict[tuple[str, int], list]:
    """Build a forward edge map from a list of SignalRouting-like objects."""
    edge_map: dict[tuple[str, int], list] = {}
    for route in routes:
        edge_map.setdefault((_logical_port_name(route.from_port_name), route.from_signal), []).append(route)
        if route.is_bidirectional:
            edge_map.setdefault((_logical_port_name(route.to_port_name), route.to_signal), []).append(_ReverseRoute(route))
    return edge_map


class _ReverseRoute:
    def __init__(self, route):
        self.from_port_name = route.to_port_name
        self.from_signal = route.to_signal
        self.to_port_name = route.from_port_name
        self.to_signal = route.from_signal
        self.is_bidirectional = route.is_bidirectional


def _build_reverse_edge_map(routes: list) -> dict[tuple[str, int], list]:
    """Build a reverse edge map from a list of SignalRouting-like objects."""
    reverse_map: dict[tuple[str, int], list] = {}
    for route in routes:
        reverse_map.setdefault((_logical_port_name(route.to_port_name), route.to_signal), []).append(route)
        if route.is_bidirectional:
            reverse_map.setdefault((_logical_port_name(route.from_port_name), route.from_signal), []).append(route)
    return reverse_map


def trace_signal_path_for_device(
    device: Device,
    port_name: str | None,
    signal: int,
) -> list[list[dict[str, Any]]]:
    """
    Trace forward signal flow for a specific device instance.

    If any DeviceSignalRouting rows exist for the device, those are used
    exclusively as the routing graph.  Otherwise falls back to the device
    type's SignalRouting entries (same behaviour as trace_signal_path).
    """
    if not port_name:
        return []

    device_routes = list(DeviceSignalRouting.objects.filter(device=device))
    if device_routes:
        routes = device_routes
    else:
        routes = list(SignalRouting.objects.filter(device_type=device.device_type))

    edge_map = _build_edge_map(routes)
    all_paths: list[list[dict[str, Any]]] = []
    visiting: set[tuple[str, int]] = set()

    def _walk(node_port: str, node_signal: int, path: list[dict[str, Any]]):
        node = (_logical_port_name(node_port), node_signal)
        if node in visiting:
            all_paths.append(path)
            return
        visiting.add(node)
        next_edges = edge_map.get(node, [])
        if not next_edges:
            all_paths.append(path)
            visiting.discard(node)
            return
        advanced = False
        for edge in next_edges:
            next_node = (_logical_port_name(edge.to_port_name), edge.to_signal)
            if next_node in visiting:
                continue
            advanced = True
            _walk(edge.to_port_name, edge.to_signal, path + [_edge_payload(edge)])
        if not advanced:
            all_paths.append(path)
        visiting.discard(node)

    _walk(port_name, signal, [])
    return all_paths


def trace_to_origin_for_device(
    device: Device,
    port_name: str | None,
    signal: int,
) -> list[list[dict[str, Any]]]:
    """
    Reverse trace for a specific device instance.

    Uses DeviceSignalRouting overrides when present, otherwise falls back to
    the device type's SignalRouting entries.
    """
    if not port_name:
        return []

    device_routes = list(DeviceSignalRouting.objects.filter(device=device))
    if device_routes:
        routes = device_routes
    else:
        routes = list(SignalRouting.objects.filter(device_type=device.device_type))

    reverse_map = _build_reverse_edge_map(routes)
    all_paths: list[list[dict[str, Any]]] = []
    visiting: set[tuple[str, int]] = set()

    def _walk_reverse(node_port: str, node_signal: int, path: list[dict[str, Any]]):
        node = (_logical_port_name(node_port), node_signal)
        if node in visiting:
            all_paths.append(path)
            return
        visiting.add(node)
        next_edges = reverse_map.get(node, [])
        if not next_edges:
            all_paths.append(path)
            visiting.discard(node)
            return
        for edge in next_edges:
            if _logical_port_name(edge.to_port_name) == _logical_port_name(node_port) and edge.to_signal == node_signal:
                _walk_reverse(edge.from_port_name, edge.from_signal, [_edge_payload(edge)] + path)
            else:
                payload = {
                    'from_port': edge.to_port_name,
                    'from_signal': edge.to_signal,
                    'to_port': edge.from_port_name,
                    'to_signal': edge.from_signal,
                    'is_bidirectional': edge.is_bidirectional,
                }
                _walk_reverse(edge.to_port_name, edge.to_signal, [payload] + path)
        visiting.discard(node)

    _walk_reverse(port_name, signal, [])
    return all_paths
