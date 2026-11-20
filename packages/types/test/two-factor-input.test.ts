import {describe,it,expect} from 'vitest';
import {LoginSchema,TwoFactorVerifySchema} from '../src/index.js';
const base={usernameOrEmail:'synuser',password:'Synthetic-Pass-1234'};
describe('two-factor login input',()=>{it('password-only without code is accepted',()=>{expect(LoginSchema.safeParse(base).success).toBe(true);});
it.each(['123456',' 123456 ','ABCDEF12','abcdef12','ABCD-EF12','abcd-ef12','AbCd-Ef12'])('accepts %s',(c)=>{const r=LoginSchema.safeParse({...base,twoFactorCode:c}); expect(r.success).toBe(true); if(r.success) expect(r.data.twoFactorCode).toBe(c.trim());});
it.each(['12345','1234567','12345a','ABCDEF1','ABCDEF123','ABCD--EF12','ABC-EF12','ABCDE-F12','GGGGGGGG','123-4567','abcd ef12','','          '])('rejects %s',(c)=>{expect(LoginSchema.safeParse({...base,twoFactorCode:c}).success).toBe(false);});
it('rejects overlong raw and non-string code',()=>{expect(LoginSchema.safeParse({...base,twoFactorCode:' '.repeat(33)}).success).toBe(false); expect(LoginSchema.safeParse({...base,twoFactorCode:123456}).success).toBe(false);});
it('enrollment verify remains strict 6 digits',()=>{expect(TwoFactorVerifySchema.safeParse({code:'123456'}).success).toBe(true); for(const c of ['ABCDEF12','ABCD-EF12',' 123456 ','12345','abcdef12']) expect(TwoFactorVerifySchema.safeParse({code:c}).success).toBe(false);});
});
