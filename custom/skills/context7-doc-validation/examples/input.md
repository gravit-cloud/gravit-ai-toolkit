# Example Input: Terraform NSG Rule Change

## Changed file: main.tf

```diff
@@ -120,6 +120,15 @@ resource "azurerm_network_security_group" "main" {
+  security_rule {
+    name                       = "allow-http"
+    priority                   = 50
+    direction                  = "Inbound"
+    access                     = "Allow"
+    protocol                   = "Tcp"
+    source_port_range          = "*"
+    destination_port_range     = "80"
+    source_address_prefix      = "*"
+    destination_address_prefix = "*"
+  }
```

## Agent input

- Changed files: `main.tf`
- Technology: terraform
- Construct: `azurerm_network_security_group.security_rule`
