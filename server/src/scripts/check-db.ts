// Quick DB state check.
import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const u = await p.appUser.count();
const ps = await p.providerSetting.count();
const k = await p.providerApiKey.count();
const s = await p.serviceApiKey.count();
console.log("AppUser:", u, "| ProviderSetting:", ps, "| ProviderApiKey:", k, "| ServiceApiKey:", s);
await p.$disconnect();
