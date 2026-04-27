from __future__ import annotations

from typing import Any

from dcim.models import DeviceType

from .models import SignalRouting


def _edge_payload(route: SignalRouting) -> dict[str, Any]:
    return {
        'from_port': route.from_port_name,
        'from_signal': route.from_signal,
        'to_port': route.to_port_name,
        'to_signal': route.to_signal,
        'is_bidirectional': route.is_bidirectional,
    }


def trace_signal_path(device_type: DeviceType, port_name: str | None, signal: int) -> list[list[dict[str, Any]]]:
    """
    Trace forward signal flow through a DeviceType's internal routing graph.

    Returns a list of branches, each branch being an ordered list of edges.
    """
    if not port_name:
        return []

    routes = list(SignalRouting.objects.filter(device_type=device_type))
    edge_map: dict[tuple[str, int], list[SignalRouting]] = {}
    for route in routes:
        edge_map.setdefault((route.from_port_name, route.from_signal), []).append(route)

    all_paths: list[list[dict[str, Any]]] = []
    visiting: set[tuple[str, int]] = set()

    def _walk(node_port: str, node_signal: int, path: list[dict[str, Any]]):
        node = (node_port, node_signal)
        if node in visiting:
            all_paths.append(path)
            return

        visiting.add(node)
        next_edges = edge_map.get(node, [])
        if not next_edges:
            all_paths.append(path)
            visiting.discard(node)
            return

        for edge in next_edges:
            payload = _edge_payload(edge)
            _walk(edge.to_port_name, edge.to_signal, path + [payload])

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
    reverse_edge_map: dict[tuple[str, int], list[SignalRouting]] = {}
    for route in routes:
        reverse_edge_map.setdefault((route.to_port_name, route.to_signal), []).append(route)
        if route.is_bidirectional:
            reverse_edge_map.setdefault((route.from_port_name, route.from_signal), []).append(route)

    all_paths: list[list[dict[str, Any]]] = []
    visiting: set[tuple[str, int]] = set()

    def _walk_reverse(node_port: str, node_signal: int, path: list[dict[str, Any]]):
        node = (node_port, node_signal)
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
            if edge.to_port_name == node_port and edge.to_signal == node_signal:
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
