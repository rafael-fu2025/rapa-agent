// Quick diagnostic script to check auto-switch configuration
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkAutoSwitch() {
  try {
    console.log('🔍 Checking Auto-Switch Configuration...\n');

    // Get all provider settings
    const settings = await prisma.providerSetting.findMany({
      include: {
        apiKeys: true
      }
    });

    if (settings.length === 0) {
      console.log('❌ No provider settings found!');
      return;
    }

    for (const setting of settings) {
      console.log(`\n📦 Provider: ${setting.provider}`);
      console.log(`   Enabled: ${setting.enabled ? '✅' : '❌'}`);
      console.log(`   Auto-Switch: ${setting.autoSwitchApiKey ? '✅ ENABLED' : '❌ DISABLED'}`);
      console.log(`   API Keys: ${setting.apiKeys.length}`);
      
      if (setting.apiKeys.length > 0) {
        console.log(`   Keys:`);
        setting.apiKeys.forEach((key, index) => {
          console.log(`     ${index + 1}. ${key.name} ${key.isActive ? '(ACTIVE)' : ''}`);
        });
      }

      if (setting.apiKeys.length === 1) {
        console.log(`   ⚠️  WARNING: Only 1 API key - auto-switch needs 2+ keys!`);
      }

      if (!setting.autoSwitchApiKey) {
        console.log(`   ⚠️  WARNING: Auto-switch is DISABLED - enable it in Settings UI!`);
      }
    }

    console.log('\n✅ Diagnostic complete!');
    console.log('\n💡 To enable auto-switch:');
    console.log('   1. Open app → Settings');
    console.log('   2. Select your provider');
    console.log('   3. Toggle ON: "Auto switch on auth/rate-limit errors"');
    console.log('   4. Add multiple API keys if you only have one');
    console.log('   5. Save\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

checkAutoSwitch();
