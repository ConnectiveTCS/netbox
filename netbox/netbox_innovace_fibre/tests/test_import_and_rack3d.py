import json

from django.test import Client, TestCase
from django.urls import reverse

from dcim.choices import DeviceStatusChoices, SubdeviceRoleChoices
from dcim.models import Device, DeviceBay, DeviceRole, DeviceType, Manufacturer, Rack, Site
from users.models import User


class InnovaceImportAndRack3DTestCase(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.site = Site.objects.create(name='Site 1', slug='site-1')
        cls.rack = Rack.objects.create(site=cls.site, name='Rack 1', u_height=42)
        cls.role = DeviceRole.objects.create(name='Role 1', slug='role-1', color='336699')
        cls.manufacturer = Manufacturer.objects.create(name='Maker 1', slug='maker-1')
        cls.parent_type = DeviceType.objects.create(
            manufacturer=cls.manufacturer,
            model='Parent Chassis',
            slug='parent-chassis',
            u_height=2,
            subdevice_role=SubdeviceRoleChoices.ROLE_PARENT,
        )
        cls.child_type = DeviceType.objects.create(
            manufacturer=cls.manufacturer,
            model='Child Device',
            slug='child-device',
            u_height=0,
            subdevice_role=SubdeviceRoleChoices.ROLE_CHILD,
        )
        cls.shelf_type = DeviceType.objects.create(
            manufacturer=cls.manufacturer,
            model='Shelf Device',
            slug='shelf-device',
            u_height=1,
            custom_field_data={'iff_device_width_in': 8.5},
        )
        cls.widthless_type = DeviceType.objects.create(
            manufacturer=cls.manufacturer,
            model='Widthless Shelf Device',
            slug='widthless-shelf-device',
            u_height=1,
        )

    def setUp(self):
        self.client = Client()

    def test_rack_3d_payload_includes_only_widthful_free_standing_shelf_devices(self):
        positioned = Device.objects.create(
            name='positioned',
            device_type=self.shelf_type,
            role=self.role,
            site=self.site,
            rack=self.rack,
            position=1,
            face='front',
            status=DeviceStatusChoices.STATUS_ACTIVE,
        )
        shelf_device = Device.objects.create(
            name='shelf-device',
            device_type=self.shelf_type,
            role=self.role,
            site=self.site,
            rack=self.rack,
            status=DeviceStatusChoices.STATUS_ACTIVE,
        )
        widthless = Device.objects.create(
            name='widthless',
            device_type=self.widthless_type,
            role=self.role,
            site=self.site,
            rack=self.rack,
            status=DeviceStatusChoices.STATUS_ACTIVE,
        )
        parent = Device.objects.create(
            name='parent',
            device_type=self.parent_type,
            role=self.role,
            site=self.site,
            rack=self.rack,
            position=3,
            face='front',
            status=DeviceStatusChoices.STATUS_ACTIVE,
        )
        bay = DeviceBay.objects.create(device=parent, name='Bay 1')
        child = Device.objects.create(
            name='child',
            device_type=self.child_type,
            role=self.role,
            site=self.site,
            rack=self.rack,
            status=DeviceStatusChoices.STATUS_ACTIVE,
        )
        bay.installed_device = child
        bay.save()

        response = self.client.get(f'/api/plugins/innovace-fibre/racks/{self.rack.pk}/3d-data/')
        self.assertEqual(response.status_code, 200)
        data = response.json()

        self.assertEqual([item['id'] for item in data['devices']], [positioned.pk, parent.pk])
        self.assertEqual([item['id'] for item in data['shelf_devices']], [shelf_device.pk])
        self.assertEqual(data['shelf_devices'][0]['shelf_width'], 8.5)
        self.assertEqual([item['id'] for item in data['widthless_shelf_devices']], [widthless.pk])

    def test_import_manager_creates_child_device_into_bay(self):
        parent = Device.objects.create(
            name='parent-import',
            device_type=self.parent_type,
            role=self.role,
            site=self.site,
            rack=self.rack,
            position=5,
            face='front',
            status=DeviceStatusChoices.STATUS_ACTIVE,
        )
        bay = DeviceBay.objects.create(device=parent, name='Bay 1')
        user = User.objects.create_user(username='admin', password='password', is_staff=True, is_superuser=True)
        self.client.force_login(user)

        response = self.client.post(
            reverse('plugins:netbox_innovace_fibre:device_bulk_create'),
            data=json.dumps({
                'rows': [{
                    'name': 'created-child',
                    'role': self.role.name,
                    'manufacturer': self.manufacturer.name,
                    'device_type': self.child_type.model,
                    'status': DeviceStatusChoices.STATUS_ACTIVE,
                    'site': self.site.name,
                    'parent': parent.name,
                    'device_bay': bay.name,
                }],
            }),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 200)
        bay.refresh_from_db()
        self.assertEqual(bay.installed_device.name, 'created-child')

    def test_import_manager_populates_existing_child_device_into_bay(self):
        parent = Device.objects.create(
            name='parent-populate',
            device_type=self.parent_type,
            role=self.role,
            site=self.site,
            rack=self.rack,
            position=7,
            face='front',
            status=DeviceStatusChoices.STATUS_ACTIVE,
        )
        bay = DeviceBay.objects.create(device=parent, name='Bay 1')
        child = Device.objects.create(
            name='existing-child',
            device_type=self.child_type,
            role=self.role,
            site=self.site,
            rack=self.rack,
            status=DeviceStatusChoices.STATUS_ACTIVE,
        )
        user = User.objects.create_user(username='admin2', password='password', is_staff=True, is_superuser=True)
        self.client.force_login(user)

        response = self.client.post(
            reverse('plugins:netbox_innovace_fibre:device_bay_bulk_populate'),
            data=json.dumps({'rows': [{'device_id': child.pk, 'device_bay_id': bay.pk}]}),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 200)
        bay.refresh_from_db()
        self.assertEqual(bay.installed_device_id, child.pk)

    def test_import_manager_rejects_populating_occupied_bay(self):
        parent = Device.objects.create(
            name='parent-occupied',
            device_type=self.parent_type,
            role=self.role,
            site=self.site,
            rack=self.rack,
            position=9,
            face='front',
            status=DeviceStatusChoices.STATUS_ACTIVE,
        )
        installed = Device.objects.create(
            name='installed-child',
            device_type=self.child_type,
            role=self.role,
            site=self.site,
            rack=self.rack,
            status=DeviceStatusChoices.STATUS_ACTIVE,
        )
        candidate = Device.objects.create(
            name='candidate-child',
            device_type=self.child_type,
            role=self.role,
            site=self.site,
            rack=self.rack,
            status=DeviceStatusChoices.STATUS_ACTIVE,
        )
        bay = DeviceBay.objects.create(device=parent, name='Bay 1', installed_device=installed)
        user = User.objects.create_user(username='admin3', password='password', is_staff=True, is_superuser=True)
        self.client.force_login(user)

        response = self.client.post(
            reverse('plugins:netbox_innovace_fibre:device_bay_bulk_populate'),
            data=json.dumps({'rows': [{'device_id': candidate.pk, 'device_bay_id': bay.pk}]}),
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()['results'][0]['status'], 'error')
