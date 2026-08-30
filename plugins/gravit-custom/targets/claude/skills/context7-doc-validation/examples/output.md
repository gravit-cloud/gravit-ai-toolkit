# Example Output: Validation Report

```yaml
validation_report:
  status: findings
  timestamp: "2026-02-21T10:30:00Z"
  changed_files:
    - file: main.tf
      technology: terraform
      library_id: /hashicorp/terraform
      constructs_checked:
        - name: azurerm_network_security_group.security_rule
          query: "azurerm_network_security_group security_rule block priority valid range"
          result: finding
          detail: >
            priority ist auf 50 gesetzt. Laut Azure-Dokumentation muss der
            Wert zwischen 100 und 4096 liegen. Werte unter 100 sind reserviert.
          doc_reference: >
            azurerm_network_security_group: security_rule.priority -
            Integer between 100 and 4096. Priority must be unique for each rule.
          suggested_fix: "priority = 200  # oder ein anderer Wert zwischen 100-4096"
        - name: azurerm_network_security_group.security_rule
          query: "azurerm_network_security_group security_rule required attributes"
          result: pass
          detail: >
            Alle Pflichtattribute (name, priority, direction, access, protocol,
            source_port_range, destination_port_range, source_address_prefix,
            destination_address_prefix) sind vorhanden.
          doc_reference: >
            azurerm_network_security_group: security_rule block -
            all listed attributes are required.
          suggested_fix: null
  summary:
    total_checks: 2
    passed: 1
    findings: 1
    skipped: 0
```

## Agent-Zusammenfassung

**Status: findings** - 1 Problem gefunden.

| Konstrukt | Pruefung | Ergebnis | Detail |
|-----------|----------|----------|--------|
| `security_rule` | priority range | finding | Wert 50 liegt ausserhalb des erlaubten Bereichs 100-4096 |
| `security_rule` | required attrs | pass | Alle Pflichtattribute vorhanden |

**Empfohlene Korrektur:**
```hcl
security_rule {
  name                       = "allow-http"
  priority                   = 200  # geaendert: muss zwischen 100-4096 liegen
  direction                  = "Inbound"
  access                     = "Allow"
  protocol                   = "Tcp"
  source_port_range          = "*"
  destination_port_range     = "80"
  source_address_prefix      = "*"
  destination_address_prefix = "*"
}
```
