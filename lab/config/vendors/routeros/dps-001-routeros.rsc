# Lab-only fragment. Map actual interfaces and install connected site/loopback/transit routes first. Review existing policies, OS release and licenses. RouterOS exports filter definitions only. No QoS, RF, credentials or physical commissioning is applied.
/routing/filter/rule add chain=STRATA-PRIMARY rule="if (dst == 10.90.0.0/24) { set bgp-local-pref 100; accept; } else { reject; }"
/routing/filter/rule add chain=STRATA-BACKUP rule="if (dst == 10.90.0.0/24) { set bgp-local-pref 80; accept; } else { reject; }"
/routing/filter/rule add chain=STRATA-EXPORT rule="if (dst == 10.81.17.0/24 || dst == 10.80.17.1/32) { accept; } else { reject; }"
