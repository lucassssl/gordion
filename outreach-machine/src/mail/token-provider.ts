import { ConfidentialClientApplication } from "@azure/msal-node";
import { X509Certificate, createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { ProviderError } from "./provider.js";

export interface GraphTokenProvider {
  getAccessToken(): Promise<string>;
}

export class AppOnlyMsalTokenProvider implements GraphTokenProvider {
  private readonly client: ConfidentialClientApplication;

  constructor(options: {
    tenantId: string;
    clientId: string;
  } & ({ clientSecret: string } | { certificatePath: string; privateKeyPath: string })) {
    const credential = "clientSecret" in options
      ? { clientSecret: options.clientSecret }
      : { clientCertificate: loadCertificate(options.certificatePath, options.privateKeyPath) };
    this.client = new ConfidentialClientApplication({
      auth: {
        authority: `https://login.microsoftonline.com/${options.tenantId}`,
        clientId: options.clientId,
        ...credential,
      },
    });
  }

  async getAccessToken(): Promise<string> {
    const result = await this.client.acquireTokenByClientCredential({
      scopes: ["https://graph.microsoft.com/.default"],
    });

    if (!result?.accessToken) {
      throw new ProviderError({
        code: "graph_token_missing",
        message: "Microsoft identity platform returned no access token",
      });
    }

    return result.accessToken;
  }
}

export function loadCertificate(certificatePath: string, privateKeyPath: string) {
  const certificate = new X509Certificate(readFileSync(certificatePath));
  const privateKey = createPrivateKey(readFileSync(privateKeyPath));
  if (!certificate.checkPrivateKey(privateKey)) throw new Error("Certificate and private key do not match");
  if (privateKey.asymmetricKeyType !== "rsa" || (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
    throw new Error("An RSA certificate of at least 2048 bits is required");
  }
  if (Date.now() < Date.parse(certificate.validFrom) || Date.now() >= Date.parse(certificate.validTo)) {
    throw new Error("Certificate is not currently valid");
  }
  return {
    thumbprintSha256: certificate.fingerprint256.replaceAll(":", ""),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}
