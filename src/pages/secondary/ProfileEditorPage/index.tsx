import Uploader from '@/components/PostEditor/Uploader'
import ProfileBanner from '@/components/ProfileBanner'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import SecondaryPageLayout from '@/layouts/SecondaryPageLayout'
import { createProfileDraftEvent } from '@/lib/draft-event'
import { generateImageByPubkey } from '@/lib/pubkey'
import { isEmail } from '@/lib/utils'
import { useSecondaryPage } from '@/PageManager'
import { useNostr } from '@/providers/NostrProvider'
import { Loader, Upload } from 'lucide-react'
import { forwardRef, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

const ProfileEditorPage = forwardRef(({ index }: { index?: number }, ref) => {
  const { t } = useTranslation()
  const { pop } = useSecondaryPage()
  const { account, profile, profileEvent, publish, updateProfileEvent } = useNostr()
  const [banner, setBanner] = useState<string>('')
  const [avatar, setAvatar] = useState<string>('')
  const [username, setUsername] = useState<string>('')
  const [about, setAbout] = useState<string>('')
  const [website, setWebsite] = useState<string>('')
  const [nip05, setNip05] = useState<string>('')
  const [nip05Error, setNip05Error] = useState<string>('')
  const [lightningAddress, setLightningAddress] = useState<string>('')
  const [lightningAddressError, setLightningAddressError] = useState<string>('')
  const [arkadeAddress, setArkadeAddress] = useState<string>('')
  const [arkadeAddressError, setArkadeAddressError] = useState<string>('')
  const [hasChanged, setHasChanged] = useState(false)
  const [saving, setSaving] = useState(false)
  const [uploadingBanner, setUploadingBanner] = useState(false)
  const [uploadingAvatar, setUploadingAvatar] = useState(false)
  const defaultImage = useMemo(
    () => (account ? generateImageByPubkey(account.pubkey) : undefined),
    [account]
  )

  useEffect(() => {
    if (profile) {
      setBanner(profile.banner ?? '')
      setAvatar(profile.avatar ?? '')
      setUsername(profile.original_username ?? '')
      setAbout(profile.about ?? '')
      setWebsite(profile.website ?? '')
      setNip05(profile.nip05 ?? '')
      setLightningAddress(profile.lightningAddress || '')
      setArkadeAddress(profile.arkade || '')
    } else {
      setBanner('')
      setAvatar('')
      setUsername('')
      setAbout('')
      setWebsite('')
      setNip05('')
      setLightningAddress('')
      setArkadeAddress('')
    }
  }, [profile])

  if (!account || !profile) return null

  const save = async () => {
    if (nip05 && !isEmail(nip05)) {
      setNip05Error(t('Invalid NIP-05 address'))
      return
    }

    const oldProfileContent = profileEvent ? JSON.parse(profileEvent.content) : {}
    const newProfileContent = {
      ...oldProfileContent,
      display_name: username,
      displayName: username,
      name: oldProfileContent.name ?? username,
      about,
      website,
      nip05,
      banner,
      picture: avatar
    }

    // Handle Lightning address
    if (lightningAddress) {
      if (isEmail(lightningAddress)) {
        newProfileContent.lud16 = lightningAddress
        delete newProfileContent.lud06 // Remove lud06 if lud16 is set
      } else if (lightningAddress.startsWith('lnurl')) {
        newProfileContent.lud06 = lightningAddress
        delete newProfileContent.lud16 // Remove lud16 if lud06 is set
      } else {
        setLightningAddressError(t('Invalid Lightning Address'))
        return
      }
    } else {
      // Remove both lud16 and lud06 if no lightning address
      delete newProfileContent.lud16
      delete newProfileContent.lud06
    }

    // Handle Arkade address
    if (arkadeAddress && arkadeAddress.trim()) {
      if (arkadeAddress.startsWith('ark1')) {
        newProfileContent.arkade = arkadeAddress.trim()
      } else {
        setArkadeAddressError(t('Invalid Arkade Address (must start with ark1)'))
        return
      }
    } else {
      delete newProfileContent.arkade
    }

    setSaving(true)
    setHasChanged(false)
    console.log('ProfileEditor - Saving profile with content:', newProfileContent)
    const profileDraftEvent = createProfileDraftEvent(
      JSON.stringify(newProfileContent),
      profileEvent?.tags
    )
    const newProfileEvent = await publish(profileDraftEvent)
    console.log('ProfileEditor - Published new profile event:', newProfileEvent)
    await updateProfileEvent(newProfileEvent)
    setSaving(false)
    pop()
  }

  const onBannerUploadSuccess = ({ url }: { url: string }) => {
    setBanner(url)
    setHasChanged(true)
  }

  const onAvatarUploadSuccess = ({ url }: { url: string }) => {
    setAvatar(url)
    setHasChanged(true)
  }

  const controls = (
    <div className="pr-3">
      <Button className="w-16 rounded-full" onClick={save} disabled={saving || !hasChanged}>
        {saving ? <Loader className="animate-spin" /> : t('Save')}
      </Button>
    </div>
  )

  return (
    <SecondaryPageLayout ref={ref} index={index} title={profile.username} controls={controls}>
      <div className="relative bg-cover bg-center mb-2">
        <Uploader
          onUploadSuccess={onBannerUploadSuccess}
          onUploadStart={() => setUploadingBanner(true)}
          onUploadEnd={() => setUploadingBanner(false)}
          className="w-full relative cursor-pointer"
        >
          <ProfileBanner banner={banner} pubkey={account.pubkey} className="w-full aspect-[3/1]" />
          <div className="absolute top-0 bg-muted/30 w-full h-full flex flex-col justify-center items-center">
            {uploadingBanner ? <Loader size={36} className="animate-spin" /> : <Upload size={36} />}
          </div>
        </Uploader>
        <Uploader
          onUploadSuccess={onAvatarUploadSuccess}
          onUploadStart={() => setUploadingAvatar(true)}
          onUploadEnd={() => setUploadingAvatar(false)}
          className="w-24 h-24 absolute bottom-0 left-4 translate-y-1/2 border-4 border-background cursor-pointer rounded-full"
        >
          <Avatar className="w-full h-full">
            <AvatarImage src={avatar} className="object-cover object-center" />
            <AvatarFallback>
              <img src={defaultImage} />
            </AvatarFallback>
          </Avatar>
          <div className="absolute top-0 bg-muted/30 w-full h-full rounded-full flex flex-col justify-center items-center">
            {uploadingAvatar ? <Loader className="animate-spin" /> : <Upload />}
          </div>
        </Uploader>
      </div>
      <div className="pt-14 px-4 flex flex-col gap-4">
        <Item>
          <Label htmlFor="profile-username-input">{t('Display Name')}</Label>
          <Input
            id="profile-username-input"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value)
              setHasChanged(true)
            }}
          />
        </Item>
        <Item>
          <Label htmlFor="profile-about-textarea">{t('Bio')}</Label>
          <Textarea
            id="profile-about-textarea"
            className="h-44"
            value={about}
            onChange={(e) => {
              setAbout(e.target.value)
              setHasChanged(true)
            }}
          />
        </Item>
        <Item>
          <Label htmlFor="profile-website-input">{t('Website')}</Label>
          <Input
            id="profile-website-input"
            value={website}
            onChange={(e) => {
              setWebsite(e.target.value)
              setHasChanged(true)
            }}
          />
        </Item>
        <Item>
          <Label htmlFor="profile-nip05-input">{t('Nostr Address (NIP-05)')}</Label>
          <Input
            id="profile-nip05-input"
            value={nip05}
            onChange={(e) => {
              setNip05Error('')
              setNip05(e.target.value)
              setHasChanged(true)
            }}
            className={nip05Error ? 'border-destructive' : ''}
          />
          {nip05Error && <div className="text-xs text-destructive pl-3">{nip05Error}</div>}
        </Item>
        <Item>
          <Label htmlFor="profile-lightning-address-input">
            {t('Lightning Address (or LNURL)')}
          </Label>
          <Input
            id="profile-lightning-address-input"
            value={lightningAddress}
            onChange={(e) => {
              setLightningAddressError('')
              setLightningAddress(e.target.value)
              setHasChanged(true)
            }}
            className={lightningAddressError ? 'border-destructive' : ''}
          />
          {lightningAddressError && (
            <div className="text-xs text-destructive pl-3">{lightningAddressError}</div>
          )}
        </Item>
        <Item>
          <Label htmlFor="profile-arkade-address-input">{t('Arkade Address')}</Label>
          <Input
            id="profile-arkade-address-input"
            placeholder="ark1q..."
            value={arkadeAddress}
            onChange={(e) => {
              setArkadeAddressError('')
              setArkadeAddress(e.target.value)
              setHasChanged(true)
            }}
            className={arkadeAddressError ? 'border-destructive' : ''}
          />
          {arkadeAddressError && (
            <div className="text-xs text-destructive pl-3">{arkadeAddressError}</div>
          )}
        </Item>
      </div>
    </SecondaryPageLayout>
  )
})
ProfileEditorPage.displayName = 'ProfileEditorPage'
export default ProfileEditorPage

function Item({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-2">{children}</div>
}
