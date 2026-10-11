FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends frr openssh-server python3 iproute2 iputils-ping iperf3 tcpdump snmpd ca-certificates && rm -rf /var/lib/apt/lists/*
COPY lab/router/entrypoint.py lab/router/device.py lab/router/probe.py /opt/strata/
RUN mkdir -p /run/sshd /root/.ssh && chmod 700 /root/.ssh && printf 'PasswordAuthentication no\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/strata.conf
ENTRYPOINT ["python3", "/opt/strata/entrypoint.py"]
