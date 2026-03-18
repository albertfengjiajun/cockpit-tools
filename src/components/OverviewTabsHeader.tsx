import { ReactNode, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AlarmClock, Fingerprint, Layers, ShieldCheck, HelpCircle } from 'lucide-react';
import { Page } from '../types/navigation';
import { RobotIcon } from './icons/RobotIcon';
import { PlatformId } from '../types/platform';
import {
  findGroupByPlatform,
  resolveGroupChildName,
  usePlatformLayoutStore,
} from '../stores/usePlatformLayoutStore';
import { getPlatformLabel } from '../utils/platformMeta';
import { PlatformGroupSwitcher } from './platform/PlatformGroupSwitcher';

interface OverviewTabsHeaderProps {
  active: Page;
  onNavigate?: (page: Page) => void;
  subtitle: string;
  title?: string;
  onOpenManual?: () => void;
}

interface TabSpec {
  key: Page;
  label: string;
  icon: ReactNode;
}

export function OverviewTabsHeader({
  active,
  onNavigate,
  subtitle,
  title,
  onOpenManual,
}: OverviewTabsHeaderProps) {
  const { t } = useTranslation();
  const { platformGroups } = usePlatformLayoutStore();
  const currentPlatformId: PlatformId = 'antigravity';
  const currentGroup = useMemo(
    () => findGroupByPlatform(platformGroups, currentPlatformId),
    [platformGroups, currentPlatformId],
  );
  const switchablePlatforms = currentGroup ? currentGroup.platformIds : [currentPlatformId];
  const currentPlatformLabel = getPlatformLabel(currentPlatformId, t);
  const currentDisplayName = useMemo(
    () =>
      title
        ? title
        : currentGroup
          ? resolveGroupChildName(currentGroup, currentPlatformId, currentPlatformLabel)
          : currentPlatformLabel,
    [title, currentGroup, currentPlatformId, currentPlatformLabel],
  );
  const switchOptions = useMemo(
    () =>
      switchablePlatforms.map((platformId) => ({
        platformId,
        label: currentGroup
          ? resolveGroupChildName(currentGroup, platformId, getPlatformLabel(platformId, t))
          : getPlatformLabel(platformId, t),
      })),
    [switchablePlatforms, currentGroup, t],
  );
  const headerTitle = title ?? t('overview.brandTitle');
  const tabs: TabSpec[] = [
    {
      key: 'overview',
      label: t('overview.title'),
      icon: <RobotIcon className="tab-icon" />,
    },
    {
      key: 'instances',
      label: t('instances.title', '多开实例'),
      icon: <Layers className="tab-icon" />,
    },
    {
      key: 'fingerprints',
      label: t('fingerprints.title'),
      icon: <Fingerprint className="tab-icon" />,
    },
    {
      key: 'wakeup',
      label: t('wakeup.title'),
      icon: <AlarmClock className="tab-icon" />,
    },
    {
      key: 'verification',
      label: t('wakeup.verification.title'),
      icon: <ShieldCheck className="tab-icon" />,
    },
  ];

  return (
    <>
      <div className="page-header">
        <div className="platform-header-title">
          <div className="page-title">{headerTitle}</div>
          {onOpenManual && (
            <button
              className="btn btn-secondary icon-only platform-header-help"
              onClick={onOpenManual}
              title={t('manual.navTitle', '功能使用手册')}
            >
              <HelpCircle size={18} />
            </button>
          )}
        </div>
        <div className="page-subtitle">{subtitle}</div>
      </div>
      <div className="page-tabs-row page-tabs-center page-tabs-row-with-leading">
        <div className="page-tabs-leading">
          <PlatformGroupSwitcher
            currentPlatformId={currentPlatformId}
            currentLabel={currentDisplayName}
            options={switchOptions}
            currentGroupId={currentGroup?.id ?? null}
          />
        </div>
        <div className="page-tabs filter-tabs">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              className={`filter-tab${active === tab.key ? ' active' : ''}`}
              onClick={() => onNavigate?.(tab.key)}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
