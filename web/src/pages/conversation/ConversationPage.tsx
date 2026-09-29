import { Box, Button, Card } from '@mui/material';
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded';
import { useNavigate, useParams } from 'react-router-dom';
import { ConversationView } from './ConversationView';

export function ConversationPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 140px)', minHeight: 480, maxWidth: 1100, mx: 'auto' }}>
      <Box sx={{ mb: 1.5 }}>
        <Button size="small" startIcon={<ArrowBackRoundedIcon />} onClick={() => navigate(`/conversations?c=${id}`)} sx={{ color: 'text.secondary' }}>
          Back to conversations
        </Button>
      </Box>
      <Card sx={{ flex: 1, minHeight: 0, bgcolor: 'background.default' }}>
        {id && <ConversationView id={id} />}
      </Card>
    </Box>
  );
}
