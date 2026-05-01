from __future__ import annotations

from typing import Any
from uuid import uuid4

from dcim.models import Cable, CableTermination, Device, DeviceType

from .models import DeviceSignalRouting, SignalRouting


TRACE_DIRECTION_CHOICES = {'a_to_b', 'b_to_a', 'bidirectional', 'unknown'}


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


# ---------------------------------------------------------------------------
# Multi-device topology tracing
# ---------------------------------------------------------------------------

def trace_full_path_from_cable(
    cable_id: int,
    entry_end: str = 'a',
    override_direction: bool = False,
    max_hops: int = 200,
) -> dict[str, Any]:
    """
    Trace a service path across cables and internal device mappings.

    entry_end is the physical cable end where light/signal enters the cable.
    Saved cable trace_direction is enforced unless override_direction is true.
    """
    index = _TraceIndex()
    cable = index.cables.get(int(cable_id))
    entry_end = _norm_end(entry_end)
    warnings: list[dict[str, Any]] = []

    if not cable:
        return {
            'trace_id': str(uuid4()),
            'start': {'cable_id': cable_id, 'entry_end': entry_end},
            'branches': [],
            'hops': [],
            'warnings': [{'message': f'Cable {cable_id} was not found.'}],
            'highlight_cable_ids': [],
        }

    start = {
        'cable_id': cable.pk,
        'label': cable.label or '',
        'entry_end': entry_end,
        'trace_direction': _trace_direction(cable),
        'override_direction': bool(override_direction),
    }

    if not _direction_allows(cable, entry_end, override_direction):
        warning = _warning(
            f'Cable {cable.pk} is configured for {_trace_direction(cable)}; tracing from {entry_end.upper()} was blocked.',
            cable_id=cable.pk,
        )
        return {
            'trace_id': str(uuid4()),
            'start': start,
            'branches': [{
                'id': 'branch-1',
                'terminal': {'reason': 'blocked_direction'},
                'hops': [],
                'warnings': [warning],
                'cable_ids': [],
                'device_ids': [],
            }],
            'hops': [],
            'warnings': [warning],
            'highlight_cable_ids': [],
        }

    branches = []
    _trace_across_cable(
        index=index,
        cable=cable,
        entry_end=entry_end,
        signal=_end_signal(cable, entry_end, 1),
        branch_hops=[],
        branch_warnings=warnings[:],
        visited_cables=set(),
        branches=branches,
        override_direction=override_direction,
        max_hops=max_hops,
    )

    all_hops = []
    highlight_ids = set()
    all_warnings = []
    for i, branch in enumerate(branches, start=1):
        branch['id'] = f'branch-{i}'
        branch['cable_ids'] = sorted({hop.get('cable_id') for hop in branch['hops'] if hop.get('type') == 'cable'})
        branch['device_ids'] = sorted({hop.get('device_id') for hop in branch['hops'] if hop.get('device_id')})
        highlight_ids.update(branch['cable_ids'])
        all_hops.extend([{**hop, 'branch_id': branch['id']} for hop in branch['hops']])
        all_warnings.extend(branch.get('warnings') or [])

    return {
        'trace_id': str(uuid4()),
        'start': start,
        'branches': branches,
        'hops': all_hops,
        'warnings': _dedupe_warnings(all_warnings),
        'highlight_cable_ids': sorted(highlight_ids),
    }


class _TraceIndex:
    def __init__(self):
        self.cables: dict[int, Cable] = {}
        self.cable_terms: dict[int, dict[str, list[dict[str, Any]]]] = {}
        self.port_links: dict[tuple[int, str], list[dict[str, Any]]] = {}
        self._load()

    def _load(self):
        rows = (
            CableTermination.objects
            .select_related('cable', 'termination_type')
            .prefetch_related('termination')
        )
        for row in rows:
            port = row.termination
            device = getattr(port, 'device', None)
            if not port or not device:
                continue
            cable = row.cable
            end = _norm_end(row.cable_end)
            self.cables[cable.pk] = cable
            entry = {
                'cable': cable,
                'cable_id': cable.pk,
                'end': end,
                'port': port,
                'port_name': port.name,
                'logical_port': _logical_port_name(port.name),
                'device': device,
                'device_id': device.pk,
                'device_name': device.name or f'Device {device.pk}',
                'signal': _end_signal(cable, end, 1),
            }
            self.cable_terms.setdefault(cable.pk, {'a': [], 'b': []})[end].append(entry)
            self.port_links.setdefault((device.pk, entry['logical_port']), []).append(entry)


def _trace_across_cable(
    *,
    index: _TraceIndex,
    cable: Cable,
    entry_end: str,
    signal: int,
    branch_hops: list[dict[str, Any]],
    branch_warnings: list[dict[str, Any]],
    visited_cables: set[int],
    branches: list[dict[str, Any]],
    override_direction: bool,
    max_hops: int,
):
    if len(branch_hops) >= max_hops:
        _finish_branch(branches, branch_hops, branch_warnings + [_warning('Trace stopped at max hop limit.', cable_id=cable.pk)], 'max_hops')
        return

    if cable.pk in visited_cables:
        _finish_branch(branches, branch_hops, branch_warnings + [_warning('Trace loop avoided by skipping an already visited cable.', cable_id=cable.pk)], 'loop')
        return

    if not _direction_allows(cable, entry_end, override_direction):
        _finish_branch(
            branches,
            branch_hops,
            branch_warnings + [_warning(f'Cable {cable.pk} direction {_trace_direction(cable)} blocks entry from {entry_end.upper()}.', cable_id=cable.pk)],
            'blocked_direction',
        )
        return

    exit_end = _opposite_end(entry_end)
    entry_terms = index.cable_terms.get(cable.pk, {}).get(entry_end, [])
    exit_terms = index.cable_terms.get(cable.pk, {}).get(exit_end, [])
    if not exit_terms:
        _finish_branch(branches, branch_hops, branch_warnings + [_warning('Cable has no opposite termination to continue trace.', cable_id=cable.pk)], 'open_cable')
        return

    for entry_term in entry_terms or [None]:
        for exit_term in exit_terms:
            exit_signal = _next_cable_signal(signal, _end_signal(cable, exit_end, signal))
            hop = {
                'type': 'cable',
                'cable_id': cable.pk,
                'label': cable.label or '',
                'entry_end': entry_end,
                'exit_end': exit_end,
                'from_device_id': entry_term.get('device_id') if entry_term else None,
                'from_device': entry_term.get('device_name') if entry_term else '',
                'from_port': entry_term.get('port_name') if entry_term else '',
                'from_logical_port': entry_term.get('logical_port') if entry_term else '',
                'from_signal': signal,
                'to_device_id': exit_term['device_id'],
                'to_device': exit_term['device_name'],
                'to_port': exit_term['port_name'],
                'to_logical_port': exit_term['logical_port'],
                'to_signal': exit_signal,
                'trace_direction': _trace_direction(cable),
            }
            _trace_through_device(
                index=index,
                device=exit_term['device'],
                port_name=exit_term['logical_port'],
                signal=exit_signal,
                branch_hops=branch_hops + [hop],
                branch_warnings=branch_warnings,
                visited_cables=visited_cables | {cable.pk},
                branches=branches,
                override_direction=override_direction,
                max_hops=max_hops,
            )


def _trace_through_device(
    *,
    index: _TraceIndex,
    device: Device,
    port_name: str,
    signal: int,
    branch_hops: list[dict[str, Any]],
    branch_warnings: list[dict[str, Any]],
    visited_cables: set[int],
    branches: list[dict[str, Any]],
    override_direction: bool,
    max_hops: int,
):
    if len(branch_hops) >= max_hops:
        _finish_branch(branches, branch_hops, branch_warnings + [_warning('Trace stopped at max hop limit.', device_id=device.pk)], 'max_hops')
        return

    paths = _trace_internal_paths_to_cabled_ports(
        index=index,
        device=device,
        port_name=port_name,
        signal=signal,
        visited_cables=visited_cables,
    )
    if not paths:
        paths = [[]]

    for path in paths:
        hops = list(branch_hops)
        warnings = list(branch_warnings)
        terminal_port = _logical_port_name(port_name)
        terminal_signal = signal

        for route in path:
            hop = {
                'type': 'internal',
                'device_id': device.pk,
                'device': device.name or f'Device {device.pk}',
                'from_port': route['from_port'],
                'from_logical_port': _logical_port_name(route['from_port']),
                'from_signal': route['from_signal'],
                'to_port': route['to_port'],
                'to_logical_port': _logical_port_name(route['to_port']),
                'to_signal': route['to_signal'],
                'bidirectional': route.get('is_bidirectional', False),
            }
            hops.append(hop)
            terminal_port = hop['to_logical_port']
            terminal_signal = hop['to_signal']

        links = [
            link for link in index.port_links.get((device.pk, terminal_port), [])
            if link['cable_id'] not in visited_cables
        ]
        if not links:
            _finish_branch(
                branches,
                hops,
                warnings,
                'terminal',
                terminal={
                    'device_id': device.pk,
                    'device': device.name or f'Device {device.pk}',
                    'port': terminal_port,
                    'signal': terminal_signal,
                },
            )
            continue

        followed = False
        for link in links:
            cable = link['cable']
            if not _signals_compatible(terminal_signal, _end_signal(cable, link['end'], terminal_signal)):
                warnings.append(_warning(
                    f'Signal {terminal_signal} reached {link["device_name"]}:{link["port_name"]}, but cable {cable.pk} is tagged for channel {_end_signal(cable, link["end"], terminal_signal)}.',
                    cable_id=cable.pk,
                    device_id=device.pk,
                ))
                continue
            if not _direction_allows(cable, link['end'], override_direction):
                warnings.append(_warning(
                    f'Cable {cable.pk} direction {_trace_direction(cable)} blocks entry from {link["end"].upper()}.',
                    cable_id=cable.pk,
                    device_id=device.pk,
                ))
                continue
            followed = True
            _trace_across_cable(
                index=index,
                cable=cable,
                entry_end=link['end'],
                signal=terminal_signal,
                branch_hops=hops,
                branch_warnings=warnings,
                visited_cables=visited_cables,
                branches=branches,
                override_direction=override_direction,
                max_hops=max_hops,
            )

        if not followed:
            _finish_branch(
                branches,
                hops,
                warnings,
                'blocked_or_unmatched_cable',
                terminal={
                    'device_id': device.pk,
                    'device': device.name or f'Device {device.pk}',
                    'port': terminal_port,
                    'signal': terminal_signal,
                },
            )


def _trace_internal_paths_to_cabled_ports(
    *,
    index: _TraceIndex,
    device: Device,
    port_name: str,
    signal: int,
    visited_cables: set[int],
    max_depth: int = 48,
    max_paths: int = 250,
) -> list[list[dict[str, Any]]]:
    """
    Find useful internal paths for a full cable trace.

    Device-level signal tracing can legitimately enumerate every simple path
    through a device. That is too expensive for switch-like device types where
    every port is bidirectionally connected to every other port. A full cable
    trace only needs paths that reach another port with an unvisited cable.
    """
    if not port_name:
        return []

    candidate_ports = {
        logical_port
        for device_id, logical_port in index.port_links
        if device_id == device.pk
        and any(link['cable_id'] not in visited_cables for link in index.port_links[(device_id, logical_port)])
    }
    start_node = (_logical_port_name(port_name), _positive_int_or_one(signal))
    candidate_ports.discard(start_node[0])
    if not candidate_ports:
        return []

    device_routes = list(DeviceSignalRouting.objects.filter(device=device))
    if device_routes:
        routes = device_routes
    else:
        routes = list(SignalRouting.objects.filter(device_type=device.device_type))

    edge_map = _build_edge_map(routes)
    queue: list[tuple[str, int, list[dict[str, Any]], set[tuple[str, int]]]] = [
        (start_node[0], start_node[1], [], {start_node})
    ]
    paths: list[list[dict[str, Any]]] = []
    best_seen: set[tuple[str, int]] = set()

    while queue and len(paths) < max_paths:
        current_port, current_signal, path, seen = queue.pop(0)
        current_node = (current_port, current_signal)
        if path and current_port in candidate_ports:
            paths.append(path)
            best_seen.add(current_node)
            continue
        if len(path) >= max_depth:
            continue
        if current_node in best_seen:
            continue

        for edge in edge_map.get(current_node, []):
            next_node = (_logical_port_name(edge.to_port_name), edge.to_signal)
            if next_node in seen:
                continue
            queue.append((
                next_node[0],
                next_node[1],
                path + [_edge_payload(edge)],
                seen | {next_node},
            ))

    return paths


def _finish_branch(branches, hops, warnings, reason, terminal=None):
    branches.append({
        'id': '',
        'terminal': terminal or {'reason': reason},
        'hops': hops,
        'warnings': _dedupe_warnings(warnings),
    })


def _trace_direction(cable: Cable) -> str:
    direction = (cable.custom_field_data or {}).get('trace_direction') or 'unknown'
    return direction if direction in TRACE_DIRECTION_CHOICES else 'unknown'


def _direction_allows(cable: Cable, entry_end: str, override_direction: bool) -> bool:
    if override_direction:
        return True
    direction = _trace_direction(cable)
    if direction in ('unknown', 'bidirectional'):
        return True
    return direction == 'a_to_b' and entry_end == 'a' or direction == 'b_to_a' and entry_end == 'b'


def _norm_end(end: str | None) -> str:
    return 'b' if str(end or '').strip().lower().startswith('b') else 'a'


def _opposite_end(end: str) -> str:
    return 'b' if _norm_end(end) == 'a' else 'a'


def _positive_int_or_one(value) -> int:
    try:
        return max(1, int(value))
    except (TypeError, ValueError):
        return 1


def _end_signal(cable: Cable, end: str, fallback: int = 1) -> int:
    data = cable.custom_field_data or {}
    key = 'source_signal_channel' if _norm_end(end) == 'a' else 'target_signal_channel'
    value = _positive_int_or_one(data.get(key) or fallback)
    return value


def _signals_compatible(route_signal, cable_signal) -> bool:
    route = _positive_int_or_one(route_signal)
    cable = _positive_int_or_one(cable_signal)
    return route == 1 or cable == 1 or route == cable


def _next_cable_signal(route_signal, cable_signal) -> int:
    route = _positive_int_or_one(route_signal)
    cable = _positive_int_or_one(cable_signal)
    return cable if cable > 1 else route


def _warning(message: str, **context) -> dict[str, Any]:
    return {'message': message, **{k: v for k, v in context.items() if v is not None}}


def _dedupe_warnings(warnings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen = set()
    out = []
    for warning in warnings:
        key = tuple(sorted(warning.items()))
        if key in seen:
            continue
        seen.add(key)
        out.append(warning)
    return out
