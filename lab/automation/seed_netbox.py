"""Run through NetBox manage.py shell inside the pinned NetBox lab container."""
import json
import os

from dcim.models import Device, DeviceRole, DeviceType, Interface, Manufacturer, Site
from django.contrib.auth import get_user_model
from django.contrib.contenttypes.models import ContentType
from ipam.models import ASN, IPAddress, Prefix, RIR, VLAN
from users.models import Token


user, created = get_user_model().objects.get_or_create(username="lab-admin", defaults={"is_staff": True, "is_superuser": True})
if created:
    user.set_password(os.environ["NETBOX_ADMIN_PASSWORD"])
    user.save()
Token.objects.get_or_create(key=os.environ["NETBOX_TOKEN"], defaults={"user": user, "write_enabled": True, "description": "Isolated Strata lab bootstrap"})
manufacturer, _ = Manufacturer.objects.get_or_create(slug="frrouting", defaults={"name": "FRRouting"})
dtype, _ = DeviceType.objects.get_or_create(slug="linux-frr-lab", manufacturer=manufacturer, defaults={"model": "Linux FRR virtual router"})
role, _ = DeviceRole.objects.get_or_create(slug="lab-access-router", defaults={"name": "Lab access router", "color": "607d8b"})
rir, _ = RIR.objects.get_or_create(slug="lab-private", defaults={"name": "Lab private", "is_private": True})
sites = json.load(open("/lab/config/sites.json", encoding="utf-8"))
site_type = ContentType.objects.get_for_model(Site)
for index, plan in enumerate(sites, 1):
    site, _ = Site.objects.get_or_create(slug=plan["id"].lower(), defaults={"name": plan["id"], "status": "active"})
    ASN.objects.get_or_create(asn=plan["asn"], defaults={"rir": rir, "description": plan["id"]})
    for purpose in ("management", "service"):
        vlan, _ = VLAN.objects.get_or_create(site=site, vid=plan[purpose + "_vlan"], defaults={"name": plan["id"] + "-" + purpose, "status": "active"})
        # No silent reassignment of an existing prefix to another site.
        prefix, was_created = Prefix.objects.get_or_create(prefix=plan[purpose], defaults={"scope_type": site_type, "scope_id": site.id, "vlan": vlan, "status": "active"})
        if prefix.scope_type_id != site_type.id or prefix.scope_id != site.id or prefix.vlan_id != vlan.id:
            raise RuntimeError("Existing NetBox prefix belongs to a different site/VLAN")
    device, _ = Device.objects.get_or_create(name=plan["id"], defaults={"site": site, "device_type": dtype, "role": role, "status": "active"})
    interface, _ = Interface.objects.get_or_create(device=device, name="lab-control", defaults={"type": "virtual"})
    address, _ = IPAddress.objects.get_or_create(address=f"172.28.80.{10+index}/24", defaults={"status": "active"})
    if address.assigned_object_id not in (None, interface.id):
        raise RuntimeError("Lab control IP is already assigned elsewhere")
    address.assigned_object = interface
    address.save()
    device.primary_ip4 = address
    device.save()
print("Seeded actual NetBox site/device/IPAM records; existing mismatched allocations are rejected.")
