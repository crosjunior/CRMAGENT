// Assinatura XMLDSig enveloped do infDPS (RSA-SHA256, C14N), como nas NFS-e do Sistema Nacional.
import { SignedXml } from 'xml-crypto';
import { DOMParser } from '@xmldom/xmldom';
import { DECLARACAO_XML } from './dps.js';

const SIG_ALG = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
const DIGEST_ALG = 'http://www.w3.org/2001/04/xmlenc#sha256';
const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';

/** Assina o elemento `localName` (Id = refId) e insere <Signature> logo depois dele. */
export function assinarElemento(xml, refId, localName, cert) {
  const xpath = `//*[local-name(.)='${localName}']`;
  const sig = new SignedXml({
    privateKey: cert.privateKeyPem,
    publicCert: cert.certPem,
    signatureAlgorithm: SIG_ALG,
    canonicalizationAlgorithm: C14N,
  });
  sig.addReference({ xpath, transforms: [ENVELOPED, C14N], digestAlgorithm: DIGEST_ALG, uri: `#${refId}` });
  sig.getKeyInfoContent = () => `<X509Data><X509Certificate>${cert.certDerBase64}</X509Certificate></X509Data>`;
  sig.computeSignature(xml.replace(/^<\?xml[^?]*\?>/, ''), { location: { reference: xpath, action: 'after' } });
  return DECLARACAO_XML + sig.getSignedXml();
}

export const assinarDps = (xml, id, cert) => assinarElemento(xml, id, 'infDPS', cert);

export function verificarAssinatura(xmlAssinado, certPem) {
  const doc = new DOMParser().parseFromString(xmlAssinado, 'text/xml');
  const node = doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature')[0];
  if (!node) return false;
  const sig = new SignedXml({ publicCert: certPem });
  sig.loadSignature(node);
  return sig.checkSignature(xmlAssinado);
}
