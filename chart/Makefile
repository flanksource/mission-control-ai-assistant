LOCALBIN ?= $(shell pwd)/.bin

$(LOCALBIN):
	mkdir -p $(LOCALBIN)

ct_install: $(LOCALBIN)
	cd $(LOCALBIN) && \
		OS=$$(uname -s | tr '[:upper:]' '[:lower:]') && \
		ARCH=$$(uname -m) && \
		if [ "$$ARCH" = "x86_64" ]; then ARCH="amd64"; fi && \
		if [ "$$ARCH" = "aarch64" ] || [ "$$ARCH" = "arm64" ]; then ARCH="arm64"; fi && \
		curl -L -o ct.tar.gz "https://github.com/helm/chart-testing/releases/download/v3.11.0/chart-testing_3.11.0_$${OS}_$${ARCH}.tar.gz" && \
		tar xzf ct.tar.gz && \
		rm ct.tar.gz


.PHONY: values.schema.json
values.schema.json: .bin/helm-schema
	.bin/helm-schema -r -f values.yaml

.PHONY: chart
chart: values.schema.json  README.md

.PHONY: README.md
README.md: .bin/helm-docs
	.bin/helm-docs   -t README.md.tpl

.bin/helm-docs:
	test -s $(LOCALBIN)/helm-docs  || \
	GOBIN=$(LOCALBIN) go install github.com/norwoodj/helm-docs/cmd/helm-docs@latest

.bin/helm-schema:
	test -s $(LOCALBIN)/helm-schema  || \
	GOBIN=$(LOCALBIN) go install github.com/dadav/helm-schema/cmd/helm-schema@latest

.PHONY: lint
lint: chart ct_install
	$(LOCALBIN)/ct lint --charts . --chart-yaml-schema $(LOCALBIN)/etc/chart_schema.yaml --lint-conf $(LOCALBIN)/etc/lintconf.yaml
