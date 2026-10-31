// Certificado digital A1 (.pfx/.p12): chave para assinar a DPS e certificado para o mTLS com a Sefin.
import fs from 'node:fs';
import forge from 'node-forge';

export function carregarCertificado(pfxPath, senha) {
  if (!pfxPath) throw new Error('Certificado não configurado (NFSE_PFX_PATH)');
  if (!fs.existsSync(pfxPath)) throw new Error(`Certificado não encontrado: ${pfxPath}`);
  const pfx = fs.readFileSync(pfxPath);
  let p12;
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(pfx.toString('binary')), senha);
  } catch {
    throw new Error('Não foi possível abrir o certificado: senha incorreta ou arquivo inválido');
  }
  const chaves = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? [];
  const chave = chaves[0]?.key ?? p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag]?.[0]?.key;
  if (!chave) throw new Error('O arquivo .pfx não contém chave privada');

  // O certificado do titular é o que casa com a chave privada (o .pfx pode trazer a cadeia junto)
  const certs = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? []).map((b) => b.cert);
  const cert = certs.find((c) => c.publicKey.n?.equals(chave.n)) ?? certs[0];
  if (!cert) throw new Error('O arquivo .pfx não contém certificado');

  const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  // Cadeia (AC intermediárias) enviada no handshake depois do certificado do titular
  const cadeiaPem = certs.filter((c) => c !== cert).map((c) => forge.pki.certificateToPem(c)).join('');
  const privateKeyPem = forge.pki.privateKeyToPem(chave);
  const certPem = forge.pki.certificateToPem(cert);
  const cn = cert.subject.getField('CN')?.value ?? '';
  return {
    pfx,
    senha,
    privateKeyPem,
    certPem,
    // Para o mTLS: chave e certificados em PEM. O .pfx não vai direto ao TLS porque os A1 da ICP-Brasil
    // costumam usar RC2/3DES, que o OpenSSL 3 do Node recusa ("Unsupported PKCS12 PFX data")
    tls: { key: privateKeyPem, cert: certPem + cadeiaPem },
    certDerBase64: forge.util.encode64(certDer),
    titular: cn,
    // e-CNPJ ICP-Brasil: CN = "RAZAO SOCIAL:12345678000199"
    cnpj: (cn.match(/:(\d{14})$/) ?? [])[1] ?? null,
    validoAte: cert.validity.notAfter,
  };
}
