from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('dcim', '0222_port_mappings'),
        ('netbox_innovace_fibre', '0001_initial'),
    ]

    operations = [
        migrations.CreateModel(
            name='DeviceSignalRouting',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('from_port_name', models.CharField(max_length=100)),
                ('from_signal', models.PositiveSmallIntegerField(default=1)),
                ('to_port_name', models.CharField(max_length=100)),
                ('to_signal', models.PositiveSmallIntegerField(default=1)),
                ('is_bidirectional', models.BooleanField(default=False)),
                (
                    'device',
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name='innovace_signal_routings',
                        to='dcim.device',
                    ),
                ),
            ],
            options={
                'verbose_name': 'device signal routing',
                'verbose_name_plural': 'device signal routings',
                'ordering': ('device', 'from_port_name', 'from_signal', 'to_port_name', 'to_signal'),
            },
        ),
        migrations.AddConstraint(
            model_name='devicesignalrouting',
            constraint=models.UniqueConstraint(
                fields=('device', 'from_port_name', 'from_signal', 'to_port_name', 'to_signal'),
                name='netbox_innovace_fibre_unique_device_signal_route',
            ),
        ),
    ]
