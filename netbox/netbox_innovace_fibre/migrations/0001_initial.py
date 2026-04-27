from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
        ('dcim', '0227_alter_interface_speed_bigint'),
    ]

    operations = [
        migrations.CreateModel(
            name='DeviceTypeSignalMeta',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('fibre_viz_type_id', models.CharField(max_length=50, unique=True)),
                ('category', models.CharField(choices=[('cassette', 'Cassette'), ('device', 'Device'), ('switch', 'Switch'), ('infrastructure', 'Infrastructure'), ('server', 'Server'), ('test_equipment', 'Test Equipment')], default='device', max_length=30)),
                ('mount_type', models.CharField(choices=[('rack', 'Rack'), ('chassis_only', 'Chassis Only'), ('non_rackable', 'Non-Rackable')], default='rack', max_length=20)),
                ('splitter_ratio', models.CharField(blank=True, max_length=10)),
                ('is_configurable', models.BooleanField(default=False)),
                ('device_type', models.OneToOneField(on_delete=models.deletion.CASCADE, related_name='innovace_signal_meta', to='dcim.devicetype')),
            ],
            options={
                'verbose_name': 'device type signal metadata',
                'verbose_name_plural': 'device type signal metadata',
                'ordering': ('device_type__manufacturer__name', 'device_type__model'),
            },
        ),
        migrations.CreateModel(
            name='SignalRouting',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('from_port_name', models.CharField(max_length=100)),
                ('from_signal', models.PositiveSmallIntegerField(default=1)),
                ('to_port_name', models.CharField(max_length=100)),
                ('to_signal', models.PositiveSmallIntegerField(default=1)),
                ('is_bidirectional', models.BooleanField(default=False)),
                ('device_type', models.ForeignKey(on_delete=models.deletion.CASCADE, related_name='innovace_signal_routings', to='dcim.devicetype')),
            ],
            options={
                'verbose_name': 'signal routing',
                'verbose_name_plural': 'signal routings',
                'ordering': ('device_type', 'from_port_name', 'from_signal', 'to_port_name', 'to_signal'),
            },
        ),
        migrations.AddConstraint(
            model_name='signalrouting',
            constraint=models.UniqueConstraint(fields=('device_type', 'from_port_name', 'from_signal', 'to_port_name', 'to_signal'), name='netbox_innovace_fibre_unique_signal_route'),
        ),
    ]
