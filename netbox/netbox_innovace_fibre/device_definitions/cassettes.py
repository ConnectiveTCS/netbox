CASSETTE_DEVICE_DEFINITIONS = [
    {
        'type_id': '1_1_normal',
        'manufacturer': 'Innovace',
        'model': '1:1 Normal',
        'u_height': 1,
        'is_full_depth': False,
        'meta': {
            'category': 'cassette',
            'mount_type': 'chassis_only',
            'splitter_ratio': '',
            'is_configurable': False,
        },
        'rear_ports': [
            {'name': 'mtp_a', 'type': 'mpo', 'positions': 12},
            {'name': 'mtp_b', 'type': 'mpo', 'positions': 12},
        ],
        'front_ports': [
            *[{'name': f'lc_{i}', 'type': 'lc', 'positions': 1} for i in range(1, 25)],
        ],
        'port_mappings': [
            *[
                {'front_port': f'lc_{i}', 'front_port_position': 1, 'rear_port': 'mtp_a', 'rear_port_position': i}
                for i in range(1, 13)
            ],
            *[
                {
                    'front_port': f'lc_{i + 12}',
                    'front_port_position': 1,
                    'rear_port': 'mtp_b',
                    'rear_port_position': i,
                }
                for i in range(1, 13)
            ],
        ],
        'signal_routings': [
            *[
                {
                    'from_port_name': 'mtp_a',
                    'from_signal': i,
                    'to_port_name': f'lc_{i}',
                    'to_signal': 1,
                    'is_bidirectional': True,
                }
                for i in range(1, 13)
            ],
            *[
                {
                    'from_port_name': 'mtp_b',
                    'from_signal': i,
                    'to_port_name': f'lc_{i + 12}',
                    'to_signal': 1,
                    'is_bidirectional': True,
                }
                for i in range(1, 13)
            ],
        ],
    },
    {
        'type_id': '1_2_normal',
        'manufacturer': 'Innovace',
        'model': '1:2 Normal',
        'u_height': 1,
        'is_full_depth': False,
        'meta': {
            'category': 'cassette',
            'mount_type': 'chassis_only',
            'splitter_ratio': '1:2',
            'is_configurable': False,
        },
        'rear_ports': [
            {'name': 'mtp_a', 'type': 'mpo', 'positions': 12},
        ],
        'front_ports': [
            *[{'name': f'lc_{i}', 'type': 'lc', 'positions': 1} for i in range(1, 25)],
        ],
        'port_mappings': [
            *[
                {'front_port': f'lc_{i}', 'front_port_position': 1, 'rear_port': 'mtp_a', 'rear_port_position': i}
                for i in range(1, 13)
            ],
            *[
                {
                    'front_port': f'lc_{i + 12}',
                    'front_port_position': 1,
                    'rear_port': 'mtp_a',
                    'rear_port_position': i,
                }
                for i in range(1, 13)
            ],
        ],
        'signal_routings': [
            *[
                {
                    'from_port_name': 'mtp_a',
                    'from_signal': i,
                    'to_port_name': f'lc_{i}',
                    'to_signal': 1,
                    'is_bidirectional': False,
                }
                for i in range(1, 13)
            ],
            *[
                {
                    'from_port_name': 'mtp_a',
                    'from_signal': i,
                    'to_port_name': f'lc_{i + 12}',
                    'to_signal': 1,
                    'is_bidirectional': False,
                }
                for i in range(1, 13)
            ],
        ],
    },
    {
        'type_id': '1_2_special',
        'manufacturer': 'Innovace',
        'model': '1:2 Special',
        'u_height': 1,
        'is_full_depth': False,
        'meta': {
            'category': 'cassette',
            'mount_type': 'chassis_only',
            'splitter_ratio': '1:2',
            'is_configurable': False,
        },
        'rear_ports': [
            {'name': 'mtp_a', 'type': 'mpo', 'positions': 12},
            {'name': 'mtp_b', 'type': 'mpo', 'positions': 12},
        ],
        'front_ports': [
            *[{'name': f'lc_{i}', 'type': 'lc', 'positions': 1} for i in range(1, 13)],
        ],
        'port_mappings': [
            *[
                {'front_port': f'lc_{i}', 'front_port_position': 1, 'rear_port': 'mtp_a', 'rear_port_position': i}
                for i in range(1, 13)
            ],
            *[
                {'front_port': f'lc_{i}', 'front_port_position': 1, 'rear_port': 'mtp_b', 'rear_port_position': i}
                for i in range(1, 13)
            ],
        ],
        'signal_routings': [
            *[
                {
                    'from_port_name': 'mtp_a',
                    'from_signal': i,
                    'to_port_name': f'lc_{i}',
                    'to_signal': 1,
                    'is_bidirectional': False,
                }
                for i in range(1, 13)
            ],
            *[
                {
                    'from_port_name': 'mtp_a',
                    'from_signal': i,
                    'to_port_name': 'mtp_b',
                    'to_signal': i,
                    'is_bidirectional': False,
                }
                for i in range(1, 13)
            ],
        ],
    },
    {
        'type_id': '1_4_normal',
        'manufacturer': 'Innovace',
        'model': '1:4 Normal',
        'u_height': 1,
        'is_full_depth': False,
        'meta': {
            'category': 'cassette',
            'mount_type': 'chassis_only',
            'splitter_ratio': '1:4',
            'is_configurable': False,
        },
        'rear_ports': [
            {'name': 'mtp_a', 'type': 'mpo', 'positions': 12},
        ],
        'front_ports': [
            *[{'name': f'lc_{i}', 'type': 'lc', 'positions': 1} for i in range(1, 25)],
        ],
        'port_mappings': [
            *[
                {'front_port': f'lc_{i}', 'front_port_position': 1, 'rear_port': 'mtp_a', 'rear_port_position': ((i - 1) // 4) + 1}
                for i in range(1, 25)
            ],
        ],
        'signal_routings': [
            *[
                {
                    'from_port_name': 'mtp_a',
                    'from_signal': ((i - 1) // 4) + 1,
                    'to_port_name': f'lc_{i}',
                    'to_signal': 1,
                    'is_bidirectional': False,
                }
                for i in range(1, 25)
            ],
        ],
    },
    {
        'type_id': 'lc_lc_adapter',
        'manufacturer': 'Innovace',
        'model': 'LC-LC Adapter',
        'u_height': 1,
        'is_full_depth': False,
        'meta': {
            'category': 'cassette',
            'mount_type': 'chassis_only',
            'splitter_ratio': '',
            'is_configurable': False,
        },
        'rear_ports': [
            *[{'name': f'lc_in_{i}', 'type': 'lc', 'positions': 1} for i in range(1, 13)],
        ],
        'front_ports': [
            *[{'name': f'lc_out_{i}', 'type': 'lc', 'positions': 1} for i in range(1, 13)],
        ],
        'port_mappings': [
            *[
                {
                    'front_port': f'lc_out_{i}',
                    'front_port_position': 1,
                    'rear_port': f'lc_in_{i}',
                    'rear_port_position': 1,
                }
                for i in range(1, 13)
            ],
        ],
        'signal_routings': [
            *[
                {
                    'from_port_name': f'lc_in_{i}',
                    'from_signal': 1,
                    'to_port_name': f'lc_out_{i}',
                    'to_signal': 1,
                    'is_bidirectional': True,
                }
                for i in range(1, 13)
            ],
        ],
    },
    {
        'type_id': 'mtp_lc_cassette',
        'manufacturer': 'Innovace',
        'model': 'MTP-LC Cassette',
        'u_height': 1,
        'is_full_depth': False,
        'meta': {
            'category': 'cassette',
            'mount_type': 'chassis_only',
            'splitter_ratio': '',
            'is_configurable': False,
        },
        'rear_ports': [
            {'name': 'mtp_a', 'type': 'mpo', 'positions': 12},
        ],
        'front_ports': [
            *[{'name': f'lc_{i}', 'type': 'lc', 'positions': 1} for i in range(1, 13)],
        ],
        'port_mappings': [
            *[
                {'front_port': f'lc_{i}', 'front_port_position': 1, 'rear_port': 'mtp_a', 'rear_port_position': i}
                for i in range(1, 13)
            ],
        ],
        'signal_routings': [
            *[
                {
                    'from_port_name': 'mtp_a',
                    'from_signal': i,
                    'to_port_name': f'lc_{i}',
                    'to_signal': 1,
                    'is_bidirectional': False,
                }
                for i in range(1, 13)
            ],
        ],
    },
    {
        'type_id': 'mtp_adapter',
        'manufacturer': 'Innovace',
        'model': 'MTP Adapter',
        'u_height': 1,
        'is_full_depth': False,
        'meta': {
            'category': 'cassette',
            'mount_type': 'chassis_only',
            'splitter_ratio': '',
            'is_configurable': False,
        },
        'rear_ports': [
            *[{'name': f'mtp_m_{i}', 'type': 'mpo', 'positions': 12} for i in range(1, 13)],
        ],
        'front_ports': [
            *[{'name': f'mtp_f_{i}', 'type': 'mpo', 'positions': 12} for i in range(1, 13)],
        ],
        'port_mappings': [
            *[
                {
                    'front_port': f'mtp_f_{i}',
                    'front_port_position': pos,
                    'rear_port': f'mtp_m_{i}',
                    'rear_port_position': pos,
                }
                for i in range(1, 13)
                for pos in range(1, 13)
            ],
        ],
        'signal_routings': [
            *[
                {
                    'from_port_name': f'mtp_m_{i}',
                    'from_signal': pos,
                    'to_port_name': f'mtp_f_{i}',
                    'to_signal': pos,
                    'is_bidirectional': True,
                }
                for i in range(1, 13)
                for pos in range(1, 13)
            ],
        ],
    },
]
