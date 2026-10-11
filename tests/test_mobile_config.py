"""Static native-config contract checks; these do not claim a live 5GC run."""
import json
import unittest
from pathlib import Path
import yaml
from scripts.render_open5gs import render

BASE = Path(__file__).resolve().parents[1] / "lab/config/mobile"


class MobileConfigurationTests(unittest.TestCase):
    def test_generator_matches_declared_native_files(self):
        files = {}
        render(lambda path, text: files.update({path: text}))
        for relative, text in files.items():
            self.assertEqual((BASE / Path(relative).name).read_text(encoding="utf-8"), text)

    def test_core_ran_subscriber_bindings_agree(self):
        read = lambda name: yaml.safe_load((BASE / name).read_text(encoding="utf-8"))
        amf, smf, upf, gnb, ue = [read(name) for name in ("amf.yaml","smf.yaml","upf.yaml","gnb.yml","ue.yml")]
        subscriber = json.loads((BASE / "subscriber.json").read_text(encoding="utf-8"))
        plmn = {"mcc":ue["mcc"], "mnc":ue["mnc"]}
        self.assertEqual(plmn,{"mcc":gnb["mcc"],"mnc":gnb["mnc"]})
        self.assertEqual(amf["amf"]["tai"][0],{"plmn_id":plmn,"tac":gnb["tac"]})
        self.assertEqual(gnb["amfConfigs"][0]["address"],amf["amf"]["ngap"]["server"][0]["address"])
        self.assertEqual(smf["smf"]["pfcp"]["client"]["upf"][0]["address"],upf["upf"]["pfcp"]["server"][0]["address"])
        for config in (smf["smf"],upf["upf"]):
            self.assertEqual(config["session"][0]["subnet"],"10.45.0.0/16")
            self.assertEqual(config["session"][0]["gateway"],"10.45.0.1")
            self.assertEqual(config["session"][0]["dnn"],ue["sessions"][0]["apn"])
        self.assertEqual(ue["supi"],f'imsi-{subscriber["imsi"]}')
        self.assertEqual(ue["key"],subscriber["security"]["k"])
        self.assertEqual(ue["op"],subscriber["security"]["opc"])
        self.assertEqual(amf["amf"]["plmn_support"][0]["s_nssai"][0]["sd"],subscriber["slice"][0]["sd"])
        self.assertEqual(int(subscriber["slice"][0]["sd"],16),ue["sessions"][0]["slice"]["sd"])


if __name__ == "__main__":
    unittest.main()
