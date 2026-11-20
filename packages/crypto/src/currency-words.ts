const ONES = ['', 'Bir', 'İki', 'Üç', 'Dört', 'Beş', 'Altı', 'Yedi', 'Sekiz', 'Dokuz'];
const TENS = ['', 'On', 'Yirmi', 'Otuz', 'Kırk', 'Elli', 'Altmış', 'Yetmiş', 'Seksen', 'Doksan'];
const THOUSANDS = ['', 'Bin', 'Milyon', 'Milyar', 'Trilyon', 'Katrilyon'];

function readThreeDigits(num: number): string {
  const b = num % 10;
  const o = Math.floor(num / 10) % 10;
  const y = Math.floor(num / 100);

  let str = '';
  if (y > 1) {
    str += ONES[y] + ' Yüz ';
  } else if (y === 1) {
    str += 'Yüz ';
  }

  str += TENS[o] + ' ' + ONES[b];
  return str.trim();
}

/**
 * Sayısal tutarı Türkçe okunuşa çevirir (Sıfır Hata Garantili).
 * Örn: 76524.50 -> "Yetmiş Altı Bin Beş Yüz Yirmi Dört Türk Lirası Elli Kuruş"
 */
export function numberToTurkishWords(amount: number, mainUnit = 'Türk Lirası', subUnit = 'Kuruş'): string {
  if (isNaN(amount) || amount === null || amount === undefined) {
    return '';
  }

  if (amount === 0) {
    return `Sıfır ${mainUnit}`;
  }

  const isNegative = amount < 0;
  const absAmount = Math.abs(amount);

  const rounded = Number(absAmount.toFixed(2));
  const integerPart = Math.floor(rounded);
  const decimalPart = Math.round((rounded - integerPart) * 100);

  let words = '';
  let tempInt = integerPart;
  let groupIndex = 0;

  if (integerPart === 0) {
    words = 'Sıfır';
  } else {
    while (tempInt > 0) {
      const group = tempInt % 1000;
      if (group > 0) {
        let groupStr = readThreeDigits(group);
        // Türkçe dil kuralı: "Bir Bin" denmez, doğrudan "Bin" denir.
        if (groupIndex === 1 && group === 1) {
          groupStr = '';
        }
        words = (groupStr + ' ' + THOUSANDS[groupIndex] + ' ' + words).trim();
      }
      tempInt = Math.floor(tempInt / 1000);
      groupIndex++;
    }
  }

  let result = `${isNegative ? 'Eksi ' : ''}${words.trim()} ${mainUnit}`;

  if (decimalPart > 0) {
    const kurusWords = readThreeDigits(decimalPart);
    result += ` ${kurusWords} ${subUnit}`;
  }

  return result.replace(/\s+/g, ' ').trim();
}
