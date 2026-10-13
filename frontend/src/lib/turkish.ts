// Şapkalı harfler düz karşılıklarıyla aynı uyumu izler.
const VOWEL_GROUP: Record<string, string> = { a: "ı", ı: "ı", â: "ı", e: "i", i: "i", î: "i", o: "u", u: "u", û: "u", ö: "ü", ü: "ü" };

/**
 * Takma adın tamlayan (ilgi) hâli, kesme işaretiyle: Ali'nin, Bora'nın, Can'ın, Gül'ün.
 * Son ünlüye göre ın/in/un/ün; ad ünlüyle bitiyorsa başına "n" gelir. Adda ünlü yoksa null
 * (çağıran ek almayan bir metin kullanır).
 */
export function genitive(name: string): string | null {
  const lower = name.toLocaleLowerCase("tr");
  const vowels = [...lower].filter((ch) => ch in VOWEL_GROUP);
  if (vowels.length === 0) return null;
  const suffix = VOWEL_GROUP[vowels[vowels.length - 1]] + "n";
  const endsWithVowel = [...lower].at(-1)! in VOWEL_GROUP;
  return `${name}'${endsWithVowel ? "n" : ""}${suffix}`;
}
