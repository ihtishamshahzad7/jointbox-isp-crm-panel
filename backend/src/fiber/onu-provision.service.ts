import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface OnuProfile {
  onuIndex: string;
  serialNumber?: string;
  vlan?: number;
  lineProfile?: string;
  svlan?: number;
  cvlan?: number;
}

/**
 * ONU Provisioning Service.
 *
 * Manages the lifecycle of an ONU on an OLT. In a GPON/EPON network, the
 * ONU must be "provisioned" (authorised) on the OLT before it can pass
 * traffic. This service generates the CLI commands for the most common
 * OLT vendors — it does NOT execute them directly (SSH/telnet is handled
 * by the caller or a separate connector).
 *
 * The subscriber link is:
 *   OLT → PON Port → Splitter → Drop Cable → ONU (customer premises)
 *
 * Providers supported: Huawei, ZTE, VSOL, BDCOM, MikroTik (RB260GS etc as
 * simple OLT-like devices).
 */
@Injectable()
export class OnuProvisionService {
  private readonly logger = new Logger(OnuProvisionService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Generate OLT CLI commands to provision an ONU.
   */
  generateProvisionCommands(olt: { vendor?: string | null; model?: string | null }, portName: string, profile: OnuProfile): string[] {
    const vendor = (olt.vendor || 'generic').toLowerCase();
    const commands: string[] = [
      `# ============================================`,
      `# Provision ONU on ${olt.vendor || 'Unknown'} OLT`,
      `# Port: ${portName}, ONU index: ${profile.onuIndex}`,
      `# Serial: ${profile.serialNumber || 'auto-detect'}`,
      `# ============================================`,
    ];

    switch (vendor) {
      case 'huawei':
        return this.huaweiProvision(portName, profile, commands);
      case 'zte':
        return this.zteProvision(portName, profile, commands);
      case 'vsol':
        return this.vsolProvision(portName, profile, commands);
      case 'bdcom':
        return this.bdcomProvision(portName, profile, commands);
      default:
        return this.genericProvision(portName, profile, commands);
    }
  }

  /**
   * Generate OLT CLI commands to unprovision (delete) an ONU.
   */
  generateUnprovisionCommands(olt: { vendor?: string | null }, portName: string, onuIndex: string): string[] {
    const vendor = (olt.vendor || 'generic').toLowerCase();
    const commands: string[] = [
      `# Unprovision ONU on port ${portName}, index ${onuIndex}`,
    ];

    switch (vendor) {
      case 'huawei':
        commands.push(`interface gpon ${portName}`);
        commands.push(`ont delete ${portName.split('/').pop()} ${onuIndex}`);
        break;
      case 'zte':
        commands.push(`exit`);
        commands.push(`pon-onu-mng ${portName}:${onuIndex}`);
        commands.push(`exit`);
        commands.push(`undo interface gpon-onu_${portName.replace(/\//g, '_')}:${onuIndex}`);
        break;
      case 'vsol':
        commands.push(`interface gpon-olt ${portName}`);
        commands.push(`no ont ${onuIndex}`);
        break;
      case 'bdcom':
        commands.push(`interface epon ${portName}`);
        commands.push(`no ont ${onuIndex}`);
        break;
      default:
        commands.push(`# Generic: delete ONU ${onuIndex} from port ${portName}`);
    }
    commands.push(`# ONU ${onuIndex} unprovisioned`);
    return commands;
  }

  /**
   * Generate commands to set ONU VLAN configuration.
   */
  generateVlanCommands(olt: { vendor?: string | null }, portName: string, onuIndex: string, svlan: number, cvlan: number): string[] {
    const vendor = (olt.vendor || 'generic').toLowerCase();
    const commands: string[] = [`# Set VLANs for ONU ${onuIndex} on port ${portName}`];

    switch (vendor) {
      case 'huawei':
        commands.push(`interface gpon ${portName}`);
        commands.push(`ont port native-vlan ${onuIndex} eth 1 vlan ${cvlan}`);
        commands.push(`service-port vlan ${svlan} gpon ${portName} ont ${onuIndex} multi-service user-vlan ${cvlan} tag-transform translate`);
        break;
      case 'zte':
        commands.push(`pon-onu-mng ${portName}:${onuIndex}`);
        commands.push(`service VLAN ${svlan} transparent`);
        commands.push(`vlan port eth_0/1 mode tag vlan ${cvlan}`);
        break;
      case 'vsol':
        commands.push(`interface gpon-olt ${portName}`);
        commands.push(`ont vlan ${onuIndex} ${cvlan} ${svlan}`);
        break;
      default:
        commands.push(`# Set VLAN ${cvlan} (C-VLAN) / ${svlan} (S-VLAN) for ONU ${onuIndex}`);
    }
    return commands;
  }

  /**
   * Generate "show" commands to check ONU status and optical power.
   */
  generateDiagnosticCommands(olt: { vendor?: string | null }, portName: string, onuIndex: string): string[] {
    const vendor = (olt.vendor || 'generic').toLowerCase();
    const commands: string[] = [`# Diagnostic commands for ONU ${onuIndex} on port ${portName}`];

    switch (vendor) {
      case 'huawei':
        commands.push(`display ont info ${portName} ${onuIndex}`);
        commands.push(`display ont optical-info ${portName} ${onuIndex}`);
        commands.push(`display ont statistics ${portName} ${onuIndex}`);
        break;
      case 'zte':
        commands.push(`show gpon onu base-info ${portName} ${onuIndex}`);
        commands.push(`show gpon onu optical-info ${portName} ${onuIndex}`);
        break;
      case 'vsol':
        commands.push(`show ont info ${portName} ${onuIndex}`);
        commands.push(`show ont optical ${portName} ${onuIndex}`);
        break;
      default:
        commands.push(`# Display ONU ${onuIndex} status on ${portName}`);
    }
    return commands;
  }

  private huaweiProvision(portName: string, profile: OnuProfile, base: string[]): string[] {
    const slotPort = portName; // e.g. "0/1/2"
    const onuId = profile.onuIndex;
    const serial = profile.serialNumber || '';
    const vlan = profile.vlan || 100;

    base.push(`config`);
    base.push(`interface gpon ${slotPort}`);
    if (serial) {
      base.push(`ont add ${slotPort.split('/').slice(0, 2).join(' ')} ${onuId} sn-auth ${serial} oam ont-lineprofile-id ${profile.lineProfile || '1'}`);
    } else {
      base.push(`ont add ${slotPort.split('/').slice(0, 2).join(' ')} ${onuId} password-auth 000000000000 oam ont-lineprofile-id ${profile.lineProfile || '1'}`);
    }
    base.push(`ont port native-vlan ${onuId} eth 1 vlan ${vlan}`);
    base.push(`quit`);
    base.push(`service-port vlan ${vlan} gpon ${slotPort} ont ${onuId} multi-service user-vlan ${vlan} tag-transform translate`);
    base.push(``);
    base.push(`# Verify:`);
    base.push(`display ont info ${slotPort} ${onuId}`);
    base.push(`display ont optical-info ${slotPort} ${onuId}`);
    return base;
  }

  private zteProvision(portName: string, profile: OnuProfile, base: string[]): string[] {
    const onuGponId = `gpon-onu_${portName.replace(/\//g, '_')}:${profile.onuIndex}`;
    const serial = profile.serialNumber || '';
    const vlan = profile.vlan || 100;

    base.push(`conf t`);
    base.push(`interface gpon-olt_${portName.replace(/\//g, '_')}`);
    if (serial) {
      base.push(`onu ${profile.onuIndex} type ZTE-F660 sn ${serial}`);
    } else {
      base.push(`onu ${profile.onuIndex} type ZTE-F660`);
    }
    base.push(`exit`);
    base.push(`pon-onu-mng ${portName}:${profile.onuIndex}`);
    base.push(`service VLAN ${vlan} transparent`);
    base.push(`vlan port eth_0/1 mode tag vlan ${vlan}`);
    base.push(`exit`);
    return base;
  }

  private vsolProvision(portName: string, profile: OnuProfile, base: string[]): string[] {
    const serial = profile.serialNumber || '';
    const vlan = profile.vlan || 100;
    const svlan = profile.svlan || vlan;
    const cvlan = profile.cvlan || vlan;

    base.push(`config`);
    base.push(`interface gpon-olt ${portName}`);
    if (serial) {
      base.push(`ont ${profile.onuIndex} sn ${serial}`);
    } else {
      base.push(`ont ${profile.onuIndex}`);
    }
    base.push(`ont vlan ${profile.onuIndex} ${cvlan} ${svlan}`);
    base.push(`exit`);
    return base;
  }

  private bdcomProvision(portName: string, profile: OnuProfile, base: string[]): string[] {
    const serial = profile.serialNumber || '';
    const vlan = profile.vlan || 100;

    base.push(`config`);
    base.push(`interface epon ${portName}`);
    if (serial) {
      base.push(`ont add ${profile.onuIndex} mac ${serial} oam-manage`);
    } else {
      base.push(`ont add ${profile.onuIndex} oam-manage`);
    }
    base.push(`ont port native-vlan ${profile.onuIndex} vlan ${vlan}`);
    base.push(`exit`);
    return base;
  }

  private genericProvision(portName: string, profile: OnuProfile, base: string[]): string[] {
    const serial = profile.serialNumber || 'auto-detect';
    base.push(`# Generic OLT provisioning — vendor-specific commands required`);
    base.push(`# Port: ${portName}, ONU index: ${profile.onuIndex}, Serial: ${serial}`);
    base.push(`# Set VLAN: ${profile.vlan || 100}`);
    base.push(`#`);
    base.push(`# For Huawei: interface gpon ${portName}`);
    base.push(`#   ont add ... ${profile.onuIndex} ${serial ? 'sn-auth ' + serial : 'password-auth ...'}`);
    base.push(`# For ZTE: interface gpon-olt_${portName.replace(/\//g, '_')}`);
    base.push(`#   onu ${profile.onuIndex} ${serial ? 'sn ' + serial : ''}`);
    return base;
  }
}