# Saylo-ийн эрхийн өөрчлөлт

Backend дээр `member` болон `admin` гэсэн role нэмэгдлээ.

## Шалгалтын төлөвлөгөө

- [x] `app_user.role` (`member` default) болон `app_user.is_active` (`true` default) багануудыг SQLite/Postgres schema startup дээр нэмэх.
- [x] Хуучин хэрэглэгчийн мөр, project өгөгдлийг хадгалсан эсэхийг migration тестээр шалгах.
- [x] Бүртгэлээр хэрэглэгч өөрөө admin эрх авах боломжгүй; зөвхөн Supabase-аар баталгаажсан Google email allowlist admin болгох.
- [x] Admin API, cross-user project/attempt болон file access, role/status өөрчлөлтөд backend authorization хийх.
- [x] Өөрийн эрх, allowlist admin болон сүүлийн active admin-ыг хамгаалах.
- [x] API/DB/team setup баримт бичиг болон frontend auth/session төрлийг шинэчлэх.
- [x] Python suite, TypeScript шалгалт, production web build ажиллуулах.
- [ ] Нууц DB password/service-role key-г Supabase дээр rotate хийсний дараа shared DB-ийн role column болон бодит Google admin нэвтрэлтийг шинээр шалгах.
- [ ] Хэрэв хэрэгтэй бол хэрэглэгч удирдах тусгай frontend admin дэлгэц нэмэх. Одоогоор FastAPI `/docs` API-г ашиглана.

**Одоогийн бодит орчин:** private `backend/.env.local` файлд `PITCH_ADMIN_EMAILS` тохируулсан бөгөөд backend startup амжилттай өнгөрөхөд DB-ийн additive schema initialization хийгддэг. Хэрэглэгчийн browser дахь шинэ Google sign-in үр дүнг эндээс шалгаагүй. Бодит Supabase-г дахин шалгахын өмнө чатад ил болсон credentials-ийг rotate хийх ёстой.

## Юу өөрчлөгдөх вэ?

- Шинэ болон одоо байгаа хэрэглэгчид `member` эрхтэй байна.
- `member` зөвхөн өөрийн project, attempt, transcript, report, audio, slide-д хандана.
- `admin` бүх хэрэглэгчийн project болон attempt-ийг харах, өөрчлөх, устгах эрхтэй. Мөн хэрэглэгчдийн role болон идэвхтэй төлөвийг удирдаж болно.
- Хэрэглэгч бүртгүүлэхдээ өөрөө `admin` сонгож чадахгүй. Backend role-ийг шалгана.
- Өгөгдлийн санд `role`, `is_active` баганууд API асах үед нэмэгдэнэ. Supabase SQL Editor дээр SQL ажиллуулах, хүснэгт устгах шаардлагагүй.

## Admin тохируулах

Итгэмжлэгдсэн Google account-ын email-үүдийг API серверийн private environment дотор таслалаар тусгаарлан `PITCH_ADMIN_EMAILS`-д бичээд backend-ээ дахин асаана:

```env
PITCH_ADMIN_EMAILS=admin@example.com,teammate@example.com
```

Жагсаалтад орсон хүн яг тэр email-тэй Google account-аар нэвтэрсний дараа `admin` болно. Багийн өөр гишүүнийг admin болгохдоо email-ийг таслалаар нэмж, backend-ээ restart хийнэ. Бодит email-үүдээ `.env.example` болон Git-д оруулахгүй.

Тохируулсан admin-ийг API-аар бууруулах боломжгүй. Тэр хүний email-ийг эхлээд `PITCH_ADMIN_EMAILS`-ээс авч backend-ээ restart хийгээд, өөр admin-аар тухайн хэрэглэгчийн role-ийг солино. Admin өөрийн role эсвэл төлөвийг өөрчлөх боломжгүй; сүүлийн идэвхтэй admin-ийг бууруулах/идэвхгүй болгохыг backend хориглоно.

## Admin API

Admin account-ын `X-Access-Token` ашиглан FastAPI-ийн `/docs` хуудаснаас:

- `GET /api/v1/admin/users` — хэрэглэгчдийн email, role, идэвхтэй төлөв, бүртгүүлсэн огноог харна.
- `PATCH /api/v1/admin/users/{user_id}` — `{"role":"admin"}`, `{"role":"member"}`, `{"is_active":false}` эсвэл `{"is_active":true}` илгээнэ.

Админ хэрэглэгчид `/admin` хуудсаас эдгээр үйлдлийг хийж болно. Тус хуудас хэрэглэгчийн бүртгэлийн мэдээлэл, эрх, идэвхтэй төлөвийг харуулна; бусдын pitch, бичлэг, transcript-ийг харуулахгүй. Хэрэглэгчийг идэвхгүй болгоход түүний нэвтрэх token-ууд хүчингүй болж, дахин идэвхжүүлсний дараа хэрэглэгч шинээр нэвтрэх шаардлагатай. API нь хүсэлт бүрт admin эрхийг давхар шалгана.

## Нууцлал

`admin` нь өндөр эрхтэй: бусдын pitch, transcript, audio, slide зэрэг хувийн өгөгдлийг харах, өөрчлөх, устгах боломжтой. Шаардлагатай, итгэлтэй хүмүүст л admin эрх өгнө. Supabase-ийн `authenticated` төлөв нь Saylo-ийн `member/admin` role-оос тусдаа.

Demo товчоор нэвтрэхэд shared `demo@pitchcoach.local` account `admin` role авна. Тус хаягаар нэвтэрсэн хүн `/admin` хуудас болон бодит admin API-д хандах боломжтой. Demo товчийг ашиглаж чадах ямар ч хүн хэрэглэгчдийн жагсаалт, эрх болон бусад хэрэглэгчийн pitch, transcript, audio, slide зэрэг хувийн өгөгдөлд хандаж, өөрчилж болохыг анхаарна уу. Local mock горимд demo preview-ийн үйлдлүүд зөвхөн жишээ өгөгдөлд нөлөөлнө.

Код татсаны дараа backend-ээ restart хийгээд `/auth/me`-ийн `role`-ийг шалгаарай. Одоо байгаа хэрэглэгчдийн өгөгдөл хэвээр үлдэнэ; schema update автоматаар, нэмэлтээр хийгдэнэ.
