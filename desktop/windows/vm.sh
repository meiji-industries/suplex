#!/bin/bash
# The Windows build VM: a VMware Fusion Windows 11 Arm VM reached over SSH. It is the VM the VM provisioning
# repository provisions (windows/setup.sh there): Visual Studio Build Tools, Rust with the x64 target, and Git.
# Suplex keeps its checkout, Cargo cache, and build output on the VM's S: disk.
#
#   SUPLEX_WINDOWS_VM_CONFIG   the VM's settings file (default: the VM provisioning one)

vm_config="${SUPLEX_WINDOWS_VM_CONFIG:-$HOME/.cache/vm-provisioning/windows/vm.conf}"
vm_key="$(dirname "$vm_config")/id_ed25519"
vmrun="/Applications/VMware Fusion.app/Contents/Library/vmrun"

vm_setting() { grep "^$1=" "$vm_config" 2>/dev/null | cut -d= -f2-; }

vm_ssh_options=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=10 -i "$vm_key")

vmrun_command() {
  local password
  password="$(vm_setting VM_PASS)"
  if [ -n "$password" ]; then "$vmrun" -vp "$password" "$@"; else "$vmrun" "$@"; fi
}

# The VM's newest DHCP lease: VMware appends leases, so the last one for its network card is current.
# A saved address goes stale when the lease moves.
vm_address() {
  local mac
  mac="$(awk -F'"' '/^ethernet0\.(generatedAddress|address)[[:space:]]*=/ { print tolower($2); exit }' "$1")"
  [ -n "$mac" ] || return 1
  awk -v mac="$mac" '
    /^lease/ { ip = $2 }
    /hardware ethernet/ { found = tolower($3); sub(/;$/, "", found); if (found == mac) address = ip }
    END { if (address) print address }
  ' /var/db/vmware/vmnet-dhcpd-*.leases 2>/dev/null
}

vm_ssh() { ssh "${vm_ssh_options[@]}" "$(vm_setting GUEST_USER)@$vm_ip" "$@"; }
vm_put() { scp "${vm_ssh_options[@]}" -q "$1" "$(vm_setting GUEST_USER)@$vm_ip:$2"; }
vm_get() { scp "${vm_ssh_options[@]}" -q "$(vm_setting GUEST_USER)@$vm_ip:$1" "$2"; }

# Starts the VM when needed and sets vm_ip once SSH answers.
vm_start() {
  local vmx
  vmx="$(vm_setting VMX_PATH)"
  [ -f "$vmx" ] || { echo "No Windows build VM: $vm_config names no VM. Set it up with windows/setup.sh in the VM provisioning repository." >&2; return 1; }
  if ! vmrun_command list | grep -qF "$vmx"; then
    echo "Starting the Windows build VM" >&2
    # In its own session: the VM process must outlive this script, and a signal to this process group
    # (Ctrl-C, a stopped task runner) would otherwise stop the VM without a shutdown.
    perl -MPOSIX -e 'setsid(); exec @ARGV' -- bash -c "source '${BASH_SOURCE[0]}'; vmrun_command start \"\$1\" nogui" _ "$vmx" </dev/null >/dev/null 2>&1
  fi
  local waited=0
  until vm_ip="$(vm_address "$vmx")" && [ -n "$vm_ip" ] && vm_ssh "echo ok" >/dev/null 2>&1; do
    waited=$((waited + 5))
    [ "$waited" -le 300 ] || { echo "The Windows build VM did not answer SSH within 5 minutes." >&2; return 1; }
    sleep 5
  done
  vm_ssh "if not exist S:\\ exit 1" || { echo "The Windows build VM has no S: build disk. See desktop/windows/README.md." >&2; return 1; }
}
